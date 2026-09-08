require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const axios = require('axios');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const NEVAPEDIA_KEY = process.env.NEVAPEDIA_API_KEY;

// Pastikan folder data & uploads ada
const dirs = [
  'data',
  'public/uploads/thumbnails',
  'public/uploads/digital_files',
  'public/uploads/avatars',
  'public/uploads/banners'
];
dirs.forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// Inisialisasi file JSON jika belum ada
['users', 'products', 'orders', 'reviews', 'reports'].forEach(file => {
  const filePath = path.join(__dirname, 'data', `${file}.json`);
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, JSON.stringify([]));
});

// JSON Database Helper
const db = {
  read: (table) => JSON.parse(fs.readFileSync(path.join(__dirname, 'data', `${table}.json`), 'utf-8')),
  write: (table, data) => fs.writeFileSync(path.join(__dirname, 'data', `${table}.json`), JSON.stringify(data, null, 2))
};

// Middleware
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'frovix_session_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 30 } // 30 hari sesi tersimpan
}));

// Variabel global untuk views
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.isAdmin = req.session.isAdmin || false;
  next();
});

// Konfigurasi Multer (Upload Gambar & ZIP/Script)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === 'thumbnail') cb(null, 'public/uploads/thumbnails');
    else if (file.fieldname === 'digital_file') cb(null, 'public/uploads/digital_files');
    else if (file.fieldname === 'avatar') cb(null, 'public/uploads/avatars');
    else if (file.fieldname === 'banner') cb(null, 'public/uploads/banners');
    else cb(null, 'public/uploads');
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${uuidv4().slice(0, 8)}${ext}`);
  }
});
const upload = multer({ storage });

// Konfigurasi Email
// Konfigurasi Email
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT) || 587,
  secure: false, // true jika port 465, false jika 587
  auth: {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || ''
  }
});
// Auth Middlewares
const isSeller = (req, res, next) => {
  if (req.session.user && req.session.user.role === 'seller') return next();
  res.redirect('/seller/login');
};

const isAdmin = (req, res, next) => {
  if (req.session.isAdmin) return next();
  res.redirect('/admin/login');
};

/* ==========================================================
   LOGIKA CENTANG BIRU (AUTO QUALIFICATION & CHECK)
========================================================== */
function checkAndApplyAutoVerification(sellerId) {
  const users = db.read('users');
  const orders = db.read('orders');
  const reviews = db.read('reviews');
  const products = db.read('products');

  const sellerIdx = users.findIndex(u => u.id === sellerId);
  if (sellerIdx === -1) return;

  const seller = users[sellerIdx];
  if (seller.is_verified) return; // Sudah centang biru

  // Syarat Otomatis: Minimal 5 penjualan sukses & rata-rata rating >= 4.5
  const sellerProductIds = products.filter(p => p.seller_id === sellerId).map(p => p.id);
  const successOrders = orders.filter(o => o.seller_id === sellerId && o.status === 'paid').length;
  
  const sellerReviews = reviews.filter(r => sellerProductIds.includes(r.product_id));
  const avgRating = sellerReviews.length 
    ? (sellerReviews.reduce((sum, r) => sum + Number(r.rating), 0) / sellerReviews.length)
    : 0;

  if (successOrders >= 5 && avgRating >= 4.5) {
    users[sellerIdx].is_verified = true;
    users[sellerIdx].verification_type = 'auto_qualified';
    db.write('users', users);
  }
}

/* ==========================================================
   SISTEM FOLLOW & UNFOLLOW TOKO
========================================================== */
app.post('/api/store/:sellerId/toggle-follow', (req, res) => {
  const currentUserId = req.session.user ? req.session.user.id : (req.sessionID || 'guest_user');
  const { sellerId } = req.params;

  let follows = db.read('follows');
  const existingIndex = follows.findIndex(f => f.follower_id === currentUserId && f.seller_id === sellerId);

  let isFollowing = false;
  if (existingIndex > -1) {
    follows.splice(existingIndex, 1); // Unfollow
  } else {
    follows.push({ id: uuidv4(), follower_id: currentUserId, seller_id: sellerId, created_at: new Date() });
    isFollowing = true;
  }
  db.write('follows', follows);

  const totalFollowers = follows.filter(f => f.seller_id === sellerId).length;
  res.json({ success: true, isFollowing, totalFollowers });
});

/* ==========================================================
   PENGAJUAN & KELOLA CENTANG BIRU OLEH ADMIN / SELLER
========================================================== */
// Seller mengajukan verifikasi centang biru
app.post('/seller/request-verification', isSeller, (req, res) => {
  const users = db.read('users');
  const idx = users.findIndex(u => u.id === req.session.user.id);
  if (idx !== -1) {
    users[idx].verification_status = 'pending';
    users[idx].verification_note = req.body.note || 'Pengajuan verifikasi portofolio toko';
    db.write('users', users);
    req.session.user = users[idx];
  }
  res.redirect('/seller/dashboard');
});

// Admin memberikan / mencabut centang biru (Manual Grant)
app.post('/admin/seller/:id/toggle-badge', isAdmin, (req, res) => {
  const users = db.read('users');
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx !== -1) {
    users[idx].is_verified = !users[idx].is_verified;
    users[idx].verification_type = users[idx].is_verified ? 'admin_grant' : null;
    users[idx].verification_status = users[idx].is_verified ? 'approved' : 'none';
    db.write('users', users);
  }
  res.redirect('/admin/dashboard');
});

/* ==========================================================
   SISTEM CHAT DENGAN TOKO (DENGAN REFERENSI PRODUK)
========================================================== */
// Halaman List Chat
app.get('/chat', (req, res) => {
  const currentUserId = req.session.user ? req.session.user.id : req.sessionID;
  const chats = db.read('chats');
  const users = db.read('users');

  // Cari kontak yang pernah bertukar pesan
  const userChats = chats.filter(c => c.sender_id === currentUserId || c.receiver_id === currentUserId);
  const contactIds = [...new Set(userChats.map(c => c.sender_id === currentUserId ? c.receiver_id : c.sender_id))];
  const contacts = users.filter(u => contactIds.includes(u.id));

  res.render('chat-list', { contacts });
});

// Buka Ruang Chat dengan Toko Spesifik & Produk Terlampir
app.get('/chat/store/:sellerId', (req, res) => {
  const { sellerId } = req.params;
  const { productId } = req.query;

  const seller = db.read('users').find(u => u.id === sellerId);
  if (!seller) return res.status(404).send('Toko tidak ditemukan');

  const product = productId ? db.read('products').find(p => p.id === productId) : null;
  const currentUserId = req.session.user ? req.session.user.id : req.sessionID;

  res.render('chat-room', { seller, product, currentUserId });
});

// API Ambil Riwayat Pesan (untuk Skeleton Chat Loader & Polling)
app.get('/api/chats/:partnerId', (req, res) => {
  const currentUserId = req.session.user ? req.session.user.id : req.sessionID;
  const partnerId = req.params.partnerId;

  const chats = db.read('chats').filter(c => 
    (c.sender_id === currentUserId && c.receiver_id === partnerId) ||
    (c.sender_id === partnerId && c.receiver_id === currentUserId)
  );

  res.json({ success: true, chats });
});

// API Kirim Pesan
app.post('/api/chats/send', (req, res) => {
  const currentUserId = req.session.user ? req.session.user.id : req.sessionID;
  const { receiver_id, message, product_id } = req.body;

  if (!message || !message.trim()) return res.status(400).json({ error: 'Pesan kosong' });

  const chats = db.read('chats');
  const product = product_id ? db.read('products').find(p => p.id === product_id) : null;

  const newChat = {
    id: uuidv4(),
    sender_id: currentUserId,
    receiver_id,
    message: message.trim(),
    product: product ? { id: product.id, title: product.title, price: product.price, thumbnail: product.thumbnail } : null,
    created_at: new Date().toISOString()
  };

  chats.push(newChat);
  db.write('chats', chats);

  res.json({ success: true, chat: newChat });
});


/* ==========================================================
   PUBLIC & BUYER ROUTES
========================================================== */

// 1. Home - List Produk & Info Seller
app.get('/', (req, res) => {
  const products = db.read('products').filter(p => p.status === 'approved');
  const users = db.read('users');
  const reviews = db.read('reviews');
  const sellers = users.filter(u => u.role === 'seller');

  const enrichedProducts = products.map(prod => {
    const seller = sellers.find(s => s.id === prod.seller_id) || {};
    const prodReviews = reviews.filter(r => r.product_id === prod.id);
    const prodAvgRating = prodReviews.length 
      ? (prodReviews.reduce((acc, r) => acc + Number(r.rating), 0) / prodReviews.length).toFixed(1) 
      : '0.0';

    const sellerProds = products.filter(p => p.seller_id === seller.id).map(p => p.id);
    const sellerReviews = reviews.filter(r => sellerProds.includes(r.product_id));
    const shopAvgRating = sellerReviews.length 
      ? (sellerReviews.reduce((acc, r) => acc + Number(r.rating), 0) / sellerReviews.length).toFixed(1) 
      : '0.0';

    return {
      ...prod,
      shop_name: seller.shop_name || 'Toko Frovix',
      seller_username: seller.username || '',
      shop_avatar: seller.avatar || '/uploads/avatars/default.png',
      product_rating: prodAvgRating,
      product_reviews_count: prodReviews.length,
      shop_rating: shopAvgRating,
      is_verified: seller.is_verified || false // <-- Memastikan centang biru seller terbawa ke produk
    };
  });

  res.render('index', { products: enrichedProducts });
});

// 2. Detail Produk & Ulasan
app.get('/product/:id', (req, res) => {
  const products = db.read('products');
  const product = products.find(p => p.id === req.params.id && p.status === 'approved');
  if (!product) return res.status(404).send('Produk tidak ditemukan atau belum disetujui');

  const seller = db.read('users').find(u => u.id === product.seller_id) || {};
  const reviews = db.read('reviews').filter(r => r.product_id === product.id);
  const avgRating = reviews.length 
    ? (reviews.reduce((acc, r) => acc + Number(r.rating), 0) / reviews.length).toFixed(1) 
    : '0.0';

  res.render('product-detail', { product, seller, reviews, avgRating });
});

// 3. Halaman Toko Seller Publik
app.get('/store/:username', (req, res) => {
  const seller = db.read('users').find(u => u.username === req.params.username && u.role === 'seller');
  if (!seller) return res.status(404).send('Toko tidak ditemukan');

  const products = db.read('products').filter(p => p.seller_id === seller.id && p.status === 'approved');
  const reviews = db.read('reviews');
  const sellerProdsIds = products.map(p => p.id);
  const sellerReviews = reviews.filter(r => sellerProdsIds.includes(r.product_id));
  const shopRating = sellerReviews.length 
    ? (sellerReviews.reduce((acc, r) => acc + Number(r.rating), 0) / sellerReviews.length).toFixed(1) 
    : '0.0';

  // Hitung Pengikut dari follows.json
  const follows = db.read('follows') || [];
  const totalFollowers = follows.filter(f => f.seller_id === seller.id).length;
  
  const currentUserId = req.session.user ? req.session.user.id : (req.sessionID || 'guest_user');
  const isFollowing = follows.some(f => f.follower_id === currentUserId && f.seller_id === seller.id);

  res.render('store', { 
    seller, 
    products, 
    shopRating, 
    totalReviews: sellerReviews.length,
    totalFollowers,
    isFollowing
  });
});
// 4. Proses Checkout -> Generate QRIS Nevapedia
app.post('/buy/:productId', async (req, res) => {
  const { buyer_name, buyer_email, buyer_phone } = req.body;
  const product = db.read('products').find(p => p.id === req.params.productId);
  if (!product) return res.status(404).json({ error: 'Produk tidak valid' });

  const finalAmount = product.discount_price ? Number(product.discount_price) : Number(product.price);

  try {
    // Panggil API Invoice Nevapedia
    const response = await axios.get(`https://app.nevapedia.com/api/invoice?apikey=${NEVAPEDIA_KEY}&amount=${finalAmount}`);
    const data = response.data;

    if (!data.success && !data.invoice_id) {
      return res.status(400).send('Gagal membuat tagihan QRIS ke Nevapedia.');
    }

    const newOrder = {
      order_id: uuidv4(),
      invoice_id: data.invoice_id,
      product_id: product.id,
      seller_id: product.seller_id,
      buyer_name,
      buyer_email,
      buyer_phone,
      amount: data.amount,
      fee: data.fee,
      total: data.total,
      qris_image: data.qris_image,
      expired_at: data.expired_at,
      status: 'pending',
      created_at: new Date().toISOString()
    };

    const orders = db.read('orders');
    orders.push(newOrder);
    db.write('orders', orders);

    res.redirect(`/checkout/${newOrder.order_id}`);
  } catch (err) {
    console.error('Error create invoice:', err.message);
    res.status(500).send('Terjadi kesalahan pada Payment Gateway.');
  }
});

// 5. Tampilan Halaman Bayar QRIS
app.get('/checkout/:orderId', (req, res) => {
  const order = db.read('orders').find(o => o.order_id === req.params.orderId);
  if (!order) return res.status(404).send('Order tidak ditemukan');

  const product = db.read('products').find(p => p.id === order.product_id);
  res.render('checkout', { order, product });
});

// 6. Polling Cek Status Pembayaran QRIS (Frontend Ajax)
app.get('/api/check-payment/:orderId', async (req, res) => {
  const orders = db.read('orders');
  const orderIndex = orders.findIndex(o => o.order_id === req.params.orderId);
  if (orderIndex === -1) return res.status(404).json({ error: 'Not found' });

  const order = orders[orderIndex];

  // Jika sudah paid di database lokal
  if (order.status === 'paid') {
  
    return res.json({ status: 'paid', download_token: order.order_id });
  }

  try {
    const resp = await axios.get(`https://app.nevapedia.com/api/invoice/status?apikey=${NEVAPEDIA_KEY}&invoice_id=${order.invoice_id}`);
    const data = resp.data;

    if (data.status === 'paid') {
checkAndApplyAutoVerification(order.seller_id);
      orders[orderIndex].status = 'paid';
      db.write('orders', orders);

      // Tambahkan saldo bersih ke akun Seller
      const users = db.read('users');
      const sellerIdx = users.findIndex(u => u.id === order.seller_id);
      if (sellerIdx !== -1) {
        users[sellerIdx].balance = (users[sellerIdx].balance || 0) + order.amount;
        db.write('users', users);
      }

      // Kirim file digital & link ke email buyer
      const product = db.read('products').find(p => p.id === order.product_id);
      const downloadLink = `${req.protocol}://${req.get('host')}/download/${order.order_id}`;

      try {
        await transporter.sendMail({
          from: `"FROVIX SHOP" <${process.env.SMTP_USER}>`,
          to: order.buyer_email,
          subject: `Pembayaran Berhasil - File Digital: ${product.title}`,
          html: `
            <h3>Halo ${order.buyer_name}, Terimakasih telah membeli di FROVIX SHOP!</h3>
            <p>Pembayaran sebesar <b>Rp ${order.total.toLocaleString()}</b> telah berhasil kami terima.</p>
            <p>Produk: <b>${product.title}</b></p>
            <p>Silakan klik link berikut untuk mendownload file produk Anda:</p>
            <p><a href="${downloadLink}" style="background:#000;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;">Download Produk Sekarang</a></p>
          `
        });
      } catch (mailErr) {
        console.log('Kirim email gagal/lewati jika smtp belum diset:', mailErr.message);
      }

      return res.json({ status: 'paid', download_token: order.order_id });
    }

    res.json({ status: data.status || 'pending' });
  } catch (err) {
    res.json({ status: 'pending' });
  }
});

// 7. Sukses Bayar & Halaman Unduh
app.get('/order/success/:orderId', (req, res) => {
  const order = db.read('orders').find(o => o.order_id === req.params.orderId);
  if (!order || order.status !== 'paid') return res.redirect('/');

  const product = db.read('products').find(p => p.id === order.product_id);
  res.render('payment-success', { order, product });
});

// 8. Download File Digital
app.get('/download/:orderId', (req, res) => {
  const order = db.read('orders').find(o => o.order_id === req.params.orderId);
  if (!order || order.status !== 'paid') return res.status(403).send('Akses download ditolak.');

  const product = db.read('products').find(p => p.id === order.product_id);
  const filePath = path.join(__dirname, 'public', product.file_url);
  if (fs.existsSync(filePath)) {
    res.download(filePath);
  } else {
    res.status(404).send('File fisik tidak ditemukan pada server.');
  }
});

// 9. Beri Ulasan & Rating
app.post('/product/:productId/review', (req, res) => {
  const { buyer_name, rating, comment } = req.body;
  const reviews = db.read('reviews');
  reviews.push({
    id: uuidv4(),
    product_id: req.params.productId,
    buyer_name: buyer_name || 'Pembeli Frovix',
    rating: Number(rating) || 5,
    comment: comment || '',
    created_at: new Date().toLocaleDateString('id-ID')
  });
  db.write('reviews', reviews);
  res.redirect(`/product/${req.params.productId}`);
});

// 10. Laporkan Seller/Produk (Anti-Scam)
app.post('/report', (req, res) => {
  const { product_id, seller_id, buyer_name, buyer_contact, reason } = req.body;
  const reports = db.read('reports');
  reports.push({
    id: uuidv4(),
    product_id,
    seller_id,
    buyer_name,
    buyer_contact,
    reason,
    created_at: new Date().toISOString()
  });
  db.write('reports', reports);
  res.send('<script>alert("Laporan penipuan Anda berhasil dikirim ke Admin FROVIX."); window.history.back();</script>');
});

/* ==========================================================
   SELLER AUTH & DASHBOARD ROUTES
========================================================== */

app.get('/seller/register', (req, res) => res.render('seller-register'));
app.post('/seller/register', async (req, res) => {
  const { username, email, password, shop_name } = req.body;
  const users = db.read('users');

  if (users.find(u => u.username === username || u.email === email)) {
    return res.status(400).send('Username atau email telah digunakan');
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const newSeller = {
    id: uuidv4(),
    role: 'seller',
    username,
    email,
    password: hashedPassword,
    shop_name: shop_name || username,
    avatar: '/uploads/avatars/default.png',
    banner: '/uploads/banners/default.jpg',
    balance: 0,
    created_at: new Date().toISOString()
  };

  users.push(newSeller);
  db.write('users', users);

  req.session.user = newSeller;
  res.redirect('/seller/dashboard');
});

app.get('/seller/login', (req, res) => res.render('seller-login'));
app.post('/seller/login', async (req, res) => {
  const { username, password } = req.body;
  const users = db.read('users');
  const user = users.find(u => (u.username === username || u.email === username) && u.role === 'seller');

  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(400).send('Kredensial login tidak valid');
  }

  req.session.user = user;
  res.redirect('/seller/dashboard');
});

app.get('/seller/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// Dashboard Seller
app.get('/seller/dashboard', isSeller, (req, res) => {
  const currentSeller = db.read('users').find(u => u.id === req.session.user.id);
  const products = db.read('products').filter(p => p.seller_id === currentSeller.id);
  const orders = db.read('orders').filter(o => o.seller_id === currentSeller.id && o.status === 'paid');

  res.render('seller-dashboard', { seller: currentSeller, products, orders });
});

// Update Profile & Banner Toko
app.post('/seller/profile', isSeller, upload.fields([{ name: 'avatar', maxCount: 1 }, { name: 'banner', maxCount: 1 }]), (req, res) => {
  const users = db.read('users');
  const idx = users.findIndex(u => u.id === req.session.user.id);
  if (idx !== -1) {
    if (req.body.shop_name) users[idx].shop_name = req.body.shop_name;
    if (req.files['avatar']) users[idx].avatar = `/uploads/avatars/${req.files['avatar'][0].filename}`;
    if (req.files['banner']) users[idx].banner = `/uploads/banners/${req.files['banner'][0].filename}`;

    db.write('users', users);
    req.session.user = users[idx];
  }
  res.redirect('/seller/dashboard');
});

// Tambah Produk Digital (Otomatis status "pending" untuk ditinjau Admin)
app.get('/seller/product/add', isSeller, (req, res) => res.render('seller-product-add', { product: null }));
app.post('/seller/product/add', isSeller, upload.fields([{ name: 'thumbnail', maxCount: 1 }, { name: 'digital_file', maxCount: 1 }]), (req, res) => {
  const { title, price, discount_price, description, category } = req.body;
  if (!req.files['thumbnail'] || !req.files['digital_file']) {
    return res.status(400).send('Thumbnail gambar dan File ZIP/Digital wajib diupload.');
  }

  const products = db.read('products');
  const newProduct = {
    id: uuidv4(),
    seller_id: req.session.user.id,
    title,
    price: Number(price),
    discount_price: discount_price ? Number(discount_price) : null,
    description,
    category: category || 'Web Scripts',
    thumbnail: `/uploads/thumbnails/${req.files['thumbnail'][0].filename}`,
    file_url: `/uploads/digital_files/${req.files['digital_file'][0].filename}`,
    file_original_name: req.files['digital_file'][0].originalname,
    status: 'pending', // Perlu di-approve Admin
    created_at: new Date().toISOString()
  };

  products.push(newProduct);
  db.write('products', products);
  res.redirect('/seller/dashboard');
});

// Hapus Produk
app.get('/seller/product/delete/:id', isSeller, (req, res) => {
  let products = db.read('products');
  products = products.filter(p => !(p.id === req.params.id && p.seller_id === req.session.user.id));
  db.write('products', products);
  res.redirect('/seller/dashboard');
});

// Penarikan Saldo (Withdraw Nevapedia)
app.get('/seller/withdraw', isSeller, async (req, res) => {
  const seller = db.read('users').find(u => u.id === req.session.user.id);
  let methods = { manual_methods: [], instant_methods: [] };
  try {
    const resp = await axios.get(`https://app.nevapedia.com/api/withdraw/methods?apikey=${NEVAPEDIA_KEY}`);
    methods = resp.data;
  } catch (err) {
    console.error('Error fetch withdraw methods:', err.message);
  }
  res.render('seller-withdraw', { seller, methods });
});

app.post('/seller/withdraw', isSeller, async (req, res) => {
  const { amount, method, account_number, instant } = req.body;
  const users = db.read('users');
  const sellerIdx = users.findIndex(u => u.id === req.session.user.id);
  const currentSeller = users[sellerIdx];

  const wdAmount = Number(amount);
  if (currentSeller.balance < wdAmount) {
    return res.status(400).send('Saldo tidak mencukupi');
  }

  try {
    const isInstant = instant === 'true';
    const resp = await axios.get(
      `https://app.nevapedia.com/api/withdraw?apikey=${NEVAPEDIA_KEY}&amount=${wdAmount}&method=${method}&account_number=${account_number}&instant=${isInstant}`
    );

    if (resp.data.success) {
      // Potong saldo
      users[sellerIdx].balance -= wdAmount;
      db.write('users', users);
      req.session.user = users[sellerIdx];
      return res.send(`<script>alert("Penarikan Berhasil Diajukan!"); window.location.href="/seller/dashboard";</script>`);
    } else {
      return res.status(400).send(resp.data.message || 'Gagal melakukan penarikan');
    }
  } catch (err) {
    res.status(500).send('Kesalahan gateway penarikan: ' + err.message);
  }
});

/* ==========================================================
   ADMIN ROUTES
========================================================== */

app.get('/admin/login', (req, res) => res.render('admin-login'));
app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.redirect('/admin/dashboard');
  }
  res.status(401).send('Kredensial Admin Salah');
});

app.get('/admin/dashboard', isAdmin, async (req, res) => {
  const products = db.read('products');
  const pendingProducts = products.filter(p => p.status === 'pending');
  const users = db.read('users');
  const reports = db.read('reports');

  let gatewayBalance = { balance: 0, pending_balance: 0 };
  try {
    const resp = await axios.get(`https://app.nevapedia.com/api/balance?apikey=${NEVAPEDIA_KEY}`);
    gatewayBalance = resp.data;
  } catch (err) {
    console.error('Nevapedia balance check error:', err.message);
  }

  res.render('admin-dashboard', { pendingProducts, users, reports, gatewayBalance });
});

// Admin Approve / Reject Produk
app.get('/admin/product/:id/status/:status', isAdmin, (req, res) => {
  const { id, status } = req.params;
  const products = db.read('products');
  const prodIdx = products.findIndex(p => p.id === id);
  if (prodIdx !== -1) {
    products[prodIdx].status = status; // 'approved' atau 'rejected'
    db.write('products', products);
  }
  res.redirect('/admin/dashboard');
});

// Admin Lihat Laporan Pembeli
app.get('/admin/reports', isAdmin, (req, res) => {
  const reports = db.read('reports');
  const products = db.read('products');
  const users = db.read('users');

  const detailedReports = reports.map(r => ({
    ...r,
    product: products.find(p => p.id === r.product_id) || {},
    seller: users.find(u => u.id === r.seller_id) || {}
  }));

  res.render('admin-reports', { reports: detailedReports });
});

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => console.log(`FROVIX SHOP running on http://localhost:${PORT}`));
}

module.exports = app;