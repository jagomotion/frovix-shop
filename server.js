const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const axios = require('axios');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const NEVAPEDIA_KEY = process.env.NEVAPEDIA_API_KEY;

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://frovixdb:VY8CAnBEgFgtrWxQ@cluster0.ileakho.mongodb.net/frovix_shop?retryWrites=true&w=majority&appName=Cluster0';

let isConnected = false;
async function connectDB() {
  if (isConnected) return;
  try {
    const db = await mongoose.connect(MONGODB_URI);
    isConnected = db.connections[0].readyState === 1;
    console.log('Db berhasil terhubung');
  } catch (err) {
    console.error('Error Db:', err.message);
  }
}

// Middleware koneksi database setiap request
app.use(async (req, res, next) => {
  await connectDB();
  next();
});

/* ==========================================================
   SCHEMA & MODEL MONGOOSE
========================================================== */
const UserSchema = new mongoose.Schema({
  role: { type: String, default: 'seller' },
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  shop_name: { type: String, default: '' },
  avatar: { type: String, default: '/uploads/avatars/default.png' },
  banner: { type: String, default: '/uploads/banners/default.jpg' },
  balance: { type: Number, default: 0 },
  is_verified: { type: Boolean, default: false },
  verification_status: { type: String, default: 'none' }, // 'none', 'pending', 'approved'
  verification_type: { type: String, default: null },     // 'auto_qualified', 'admin_grant'
  verification_note: { type: String, default: '' }
}, { timestamps: true });

const ProductSchema = new mongoose.Schema({
  seller_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true },
  price: { type: Number, required: true },
  discount_price: { type: Number, default: null },
  category: { type: String, default: 'Web Scripts' },
  description: { type: String, default: '' },
  thumbnail: { type: String, required: true },
  file_url: { type: String, required: true },
  file_original_name: { type: String, default: '' },
  status: { type: String, default: 'pending' } // 'pending', 'approved', 'rejected'
}, { timestamps: true });

const OrderSchema = new mongoose.Schema({
  order_id: { type: String, required: true, unique: true },
  invoice_id: { type: String, required: true },
  product_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  seller_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  buyer_name: { type: String, required: true },
  buyer_email: { type: String, required: true },
  buyer_phone: { type: String, required: true },
  amount: { type: Number, required: true },
  fee: { type: Number, default: 0 },
  total: { type: Number, required: true },
  qris_image: { type: String },
  expired_at: { type: String },
  status: { type: String, default: 'pending' } // 'pending', 'paid'
}, { timestamps: true });

const ReviewSchema = new mongoose.Schema({
  product_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  buyer_name: { type: String, default: 'Pembeli' },
  rating: { type: Number, default: 5 },
  comment: { type: String, default: '' }
}, { timestamps: true });

const ReportSchema = new mongoose.Schema({
  product_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
  seller_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  buyer_name: { type: String, required: true },
  buyer_contact: { type: String, required: true },
  reason: { type: String, required: true }
}, { timestamps: true });

const ChatSchema = new mongoose.Schema({
  sender_id: { type: String, required: true },
  receiver_id: { type: String, required: true },
  message: { type: String, required: true },
  product: {
    id: String,
    title: String,
    price: Number,
    thumbnail: String
  }
}, { timestamps: true });

const FollowSchema = new mongoose.Schema({
  follower_id: { type: String, required: true },
  seller_id: { type: String, required: true }
}, { timestamps: true });

const User = mongoose.models.User || mongoose.model('User', UserSchema);
const Product = mongoose.models.Product || mongoose.model('Product', ProductSchema);
const Order = mongoose.models.Order || mongoose.model('Order', OrderSchema);
const Review = mongoose.models.Review || mongoose.model('Review', ReviewSchema);
const Report = mongoose.models.Report || mongoose.model('Report', ReportSchema);
const Chat = mongoose.models.Chat || mongoose.model('Chat', ChatSchema);
const Follow = mongoose.models.Follow || mongoose.model('Follow', FollowSchema);

/* ==========================================================
   FOLDER UPLOADS & MULTI-PART SETUP
========================================================== */
['public/uploads/thumbnails', 'public/uploads/digital_files', 'public/uploads/avatars', 'public/uploads/banners'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === 'thumbnail') cb(null, 'public/uploads/thumbnails');
    else if (file.fieldname === 'digital_file') cb(null, 'public/uploads/digital_files');
    else if (file.fieldname === 'avatar') cb(null, 'public/uploads/avatars');
    else if (file.fieldname === 'banner') cb(null, 'public/uploads/banners');
    else cb(null, 'public/uploads');
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${uuidv4().slice(0, 8)}${path.extname(file.originalname)}`);
  }
});
const upload = multer({ storage });

// Email Transporter
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || ''
  }
});

// Express Config
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'frovix_session_secret_998',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 30 }
}));

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.isAdmin = req.session.isAdmin || false;
  next();
});

const isSeller = (req, res, next) => {
  if (req.session.user && req.session.user.role === 'seller') return next();
  res.redirect('/seller/login');
};

const isAdmin = (req, res, next) => {
  if (req.session.isAdmin) return next();
  res.redirect('/admin/login');
};

// Logika Verifikasi Otomatis
async function checkAndApplyAutoVerification(sellerId) {
  try {
    const seller = await User.findById(sellerId);
    if (!seller || seller.is_verified) return;

    const successOrdersCount = await Order.countDocuments({ seller_id: sellerId, status: 'paid' });
    const sellerProducts = await Product.find({ seller_id: sellerId }).select('_id');
    const prodIds = sellerProducts.map(p => p._id);

    const reviews = await Review.find({ product_id: { $in: prodIds } });
    const avgRating = reviews.length ? (reviews.reduce((s, r) => s + r.rating, 0) / reviews.length) : 0;

    if (successOrdersCount >= 5 && avgRating >= 4.5) {
      seller.is_verified = true;
      seller.verification_type = 'auto_qualified';
      await seller.save();
    }
  } catch (e) {
    console.error('Auto verify error:', e.message);
  }
}

/* ==========================================================
   PUBLIC & BUYER ROUTES
========================================================== */

// 1. Home
app.get('/', async (req, res) => {
  try {
    const products = await Product.find({ status: 'approved' }).populate('seller_id').lean();
    const reviews = await Review.find().lean();
    const totalSellers = await User.countDocuments({ role: 'seller' });

    const enrichedProducts = products.map(prod => {
      const seller = prod.seller_id || {};
      const prodReviews = reviews.filter(r => r.product_id.toString() === prod._id.toString());
      const prodAvgRating = prodReviews.length 
        ? (prodReviews.reduce((acc, r) => acc + Number(r.rating), 0) / prodReviews.length).toFixed(1) 
        : '0.0';

      return {
        ...prod,
        id: prod._id.toString(),
        shop_name: seller.shop_name || 'Toko Frovix',
        seller_username: seller.username || '',
        shop_avatar: seller.avatar || '/uploads/avatars/default.png',
        product_rating: prodAvgRating,
        product_reviews_count: prodReviews.length,
        is_verified: seller.is_verified || false
      };
    });

    res.render('index', {
      products: enrichedProducts,
      totalSellers,
      totalProducts: products.length
    });
  } catch (err) {
    res.status(500).send('Database Error: ' + err.message);
  }
});

// 2. Detail Produk
app.get('/product/:id', async (req, res) => {
  try {
    const product = await Product.findOne({ _id: req.params.id, status: 'approved' }).populate('seller_id').lean();
    if (!product) return res.status(404).send('Produk tidak ditemukan');

    const seller = product.seller_id || {};
    const reviews = await Review.find({ product_id: product._id }).sort({ createdAt: -1 }).lean();
    const avgRating = reviews.length 
      ? (reviews.reduce((acc, r) => acc + Number(r.rating), 0) / reviews.length).toFixed(1) 
      : '0.0';

    res.render('product-detail', { 
      product: { ...product, id: product._id.toString() }, 
      seller: { ...seller, id: seller._id ? seller._id.toString() : '' }, 
      reviews, 
      avgRating 
    });
  } catch (err) {
    res.status(404).send('Produk tidak valid');
  }
});

// 3. Halaman Toko Publik
app.get('/store/:username', async (req, res) => {
  try {
    const seller = await User.findOne({ username: req.params.username, role: 'seller' }).lean();
    if (!seller) return res.status(404).send('Toko tidak ditemukan');

    const products = await Product.find({ seller_id: seller._id, status: 'approved' }).lean();
    const prodIds = products.map(p => p._id);
    const sellerReviews = await Review.find({ product_id: { $in: prodIds } }).lean();

    const shopRating = sellerReviews.length 
      ? (sellerReviews.reduce((acc, r) => acc + Number(r.rating), 0) / sellerReviews.length).toFixed(1) 
      : '0.0';

    const totalFollowers = await Follow.countDocuments({ seller_id: seller._id.toString() });
    const currentUserId = req.session.user ? req.session.user.id : (req.sessionID || 'guest');
    const isFollowing = !!(await Follow.findOne({ follower_id: currentUserId, seller_id: seller._id.toString() }));

    res.render('store', {
      seller: { ...seller, id: seller._id.toString() },
      products: products.map(p => ({ ...p, id: p._id.toString() })),
      shopRating,
      totalReviews: sellerReviews.length,
      totalFollowers,
      isFollowing
    });
  } catch (err) {
    res.status(500).send('Error toko: ' + err.message);
  }
});

// 4. Follow Toko Toggle
app.post('/api/store/:sellerId/toggle-follow', async (req, res) => {
  try {
    const currentUserId = req.session.user ? req.session.user.id : (req.sessionID || 'guest');
    const { sellerId } = req.params;

    const existing = await Follow.findOne({ follower_id: currentUserId, seller_id: sellerId });
    let isFollowing = false;

    if (existing) {
      await Follow.deleteOne({ _id: existing._id });
    } else {
      await Follow.create({ follower_id: currentUserId, seller_id: sellerId });
      isFollowing = true;
    }

    const totalFollowers = await Follow.countDocuments({ seller_id: sellerId });
    res.json({ success: true, isFollowing, totalFollowers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Beli & Buat QRIS Nevapedia
app.post('/buy/:productId', async (req, res) => {
  try {
    const { buyer_name, buyer_email, buyer_phone } = req.body;
    const product = await Product.findById(req.params.productId);
    if (!product) return res.status(404).send('Produk tidak ditemukan');

    const finalAmount = product.discount_price ? Number(product.discount_price) : Number(product.price);
    const response = await axios.get(`https://app.nevapedia.com/api/invoice?apikey=${NEVAPEDIA_KEY}&amount=${finalAmount}`);
    const data = response.data;

    if (!data.invoice_id) return res.status(400).send('Gagal generate invoice QRIS');

    const order = await Order.create({
      order_id: uuidv4(),
      invoice_id: data.invoice_id,
      product_id: product._id,
      seller_id: product.seller_id,
      buyer_name,
      buyer_email,
      buyer_phone,
      amount: data.amount,
      fee: data.fee,
      total: data.total,
      qris_image: data.qris_image,
      expired_at: data.expired_at,
      status: 'pending'
    });

    res.redirect(`/checkout/${order.order_id}`);
  } catch (err) {
    res.status(500).send('Error gateway: ' + err.message);
  }
});

// 6. Tampilan Checkout QRIS
app.get('/checkout/:orderId', async (req, res) => {
  try {
    const order = await Order.findOne({ order_id: req.params.orderId });
    if (!order) return res.status(404).send('Pesanan tidak ada');

    const product = await Product.findById(order.product_id);
    res.render('checkout', { order, product });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// 7. Polling Pembayaran QRIS
app.get('/api/check-payment/:orderId', async (req, res) => {
  try {
    const order = await Order.findOne({ order_id: req.params.orderId });
    if (!order) return res.status(404).json({ error: 'Not found' });

    if (order.status === 'paid') {
      return res.json({ status: 'paid', download_token: order.order_id });
    }

    const resp = await axios.get(`https://app.nevapedia.com/api/invoice/status?apikey=${NEVAPEDIA_KEY}&invoice_id=${order.invoice_id}`);
    const data = resp.data;

    if (data.status === 'paid') {
      order.status = 'paid';
      await order.save();

      // Tambah Saldo ke Seller
      await User.findByIdAndUpdate(order.seller_id, { $inc: { balance: order.amount } });
      await checkAndApplyAutoVerification(order.seller_id);

      // Kirim Notifikasi Email
      const product = await Product.findById(order.product_id);
      const downloadLink = `${req.protocol}://${req.get('host')}/download/${order.order_id}`;

      try {
        await transporter.sendMail({
          from: `"FROVIX SHOP" <${process.env.SMTP_USER}>`,
          to: order.buyer_email,
          subject: `Pesanan Berhasil: ${product.title}`,
          html: `<p>Halo ${order.buyer_name}, pembayaran berhasil!</p><p><a href="${downloadLink}">Download File Produk</a></p>`
        });
      } catch (mErr) {
        console.log('SMTP error:', mErr.message);
      }

      return res.json({ status: 'paid', download_token: order.order_id });
    }

    res.json({ status: data.status || 'pending' });
  } catch (err) {
    res.json({ status: 'pending' });
  }
});

// 8. Sukses Pembayaran
app.get('/order/success/:orderId', async (req, res) => {
  const order = await Order.findOne({ order_id: req.params.orderId, status: 'paid' });
  if (!order) return res.redirect('/');

  const product = await Product.findById(order.product_id);
  res.render('payment-success', { order, product });
});

// 9. Download File
app.get('/download/:orderId', async (req, res) => {
  const order = await Order.findOne({ order_id: req.params.orderId, status: 'paid' });
  if (!order) return res.status(403).send('Akses download ditolak');

  const product = await Product.findById(order.product_id);
  const filePath = path.join(__dirname, 'public', product.file_url);

  if (fs.existsSync(filePath)) {
    res.download(filePath);
  } else {
    res.status(404).send('File fisik tidak ditemukan pada server.');
  }
});

// 10. Tambah Review
app.post('/product/:productId/review', async (req, res) => {
  try {
    await Review.create({
      product_id: req.params.productId,
      buyer_name: req.body.buyer_name || 'Pembeli',
      rating: Number(req.body.rating) || 5,
      comment: req.body.comment || ''
    });
    res.redirect(`/product/${req.params.productId}`);
  } catch (err) {
    res.redirect('back');
  }
});

// 11. Laporkan Seller / Produk
app.post('/report', async (req, res) => {
  try {
    await Report.create({
      product_id: req.body.product_id,
      seller_id: req.body.seller_id,
      buyer_name: req.body.buyer_name,
      buyer_contact: req.body.buyer_contact,
      reason: req.body.reason
    });
    res.send('<script>alert("Laporan Anda telah terkirim ke Admin."); window.history.back();</script>');
  } catch (err) {
    res.send('<script>alert("Gagal kirim laporan"); window.history.back();</script>');
  }
});

/* ==========================================================
   FITUR CHAT
========================================================== */
app.get('/chat', async (req, res) => {
  const currentUserId = req.session.user ? req.session.user.id : req.sessionID;
  const userChats = await Chat.find({
    $or: [{ sender_id: currentUserId }, { receiver_id: currentUserId }]
  }).lean();

  const partnerIds = [...new Set(userChats.map(c => c.sender_id === currentUserId ? c.receiver_id : c.sender_id))];
  const contacts = await User.find({ _id: { $in: partnerIds } }).lean();

  res.render('chat-list', { contacts: contacts.map(c => ({ ...c, id: c._id.toString() })) });
});

app.get('/chat/store/:sellerId', async (req, res) => {
  try {
    const seller = await User.findById(req.params.sellerId).lean();
    if (!seller) return res.status(404).send('Toko tidak ada');

    const product = req.query.productId ? await Product.findById(req.query.productId).lean() : null;
    const currentUserId = req.session.user ? req.session.user.id : req.sessionID;

    res.render('chat-room', { 
      seller: { ...seller, id: seller._id.toString() }, 
      product: product ? { ...product, id: product._id.toString() } : null, 
      currentUserId 
    });
  } catch (err) {
    res.status(404).send('Gagal membuka chat');
  }
});

app.get('/api/chats/:partnerId', async (req, res) => {
  const currentUserId = req.session.user ? req.session.user.id : req.sessionID;
  const partnerId = req.params.partnerId;

  const chats = await Chat.find({
    $or: [
      { sender_id: currentUserId, receiver_id: partnerId },
      { sender_id: partnerId, receiver_id: currentUserId }
    ]
  }).sort({ createdAt: 1 }).lean();

  res.json({ success: true, chats });
});

app.post('/api/chats/send', async (req, res) => {
  try {
    const currentUserId = req.session.user ? req.session.user.id : req.sessionID;
    const { receiver_id, message, product_id } = req.body;

    let prodData = null;
    if (product_id) {
      const p = await Product.findById(product_id);
      if (p) prodData = { id: p._id.toString(), title: p.title, price: p.price, thumbnail: p.thumbnail };
    }

    const chat = await Chat.create({
      sender_id: currentUserId,
      receiver_id,
      message: message.trim(),
      product: prodData
    });

    res.json({ success: true, chat });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ==========================================================
   SELLER AUTH & DASHBOARD
========================================================== */
app.get('/seller/register', (req, res) => res.render('seller-register'));
app.post('/seller/register', async (req, res) => {
  try {
    const { username, email, password, shop_name } = req.body;
    const exists = await User.findOne({ $or: [{ username }, { email }] });
    if (exists) return res.status(400).send('Username atau email telah digunakan');

    const hashedPassword = await bcrypt.hash(password, 10);
    const newSeller = await User.create({
      username,
      email,
      password: hashedPassword,
      shop_name: shop_name || username,
      role: 'seller'
    });

    req.session.user = { id: newSeller._id.toString(), username, role: 'seller', shop_name: newSeller.shop_name };
    res.redirect('/seller/dashboard');
  } catch (err) {
    res.status(500).send('Registrasi gagal: ' + err.message);
  }
});

app.get('/seller/login', (req, res) => res.render('seller-login'));
app.post('/seller/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ $or: [{ username }, { email: username }], role: 'seller' });

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(400).send('Kredensial login tidak valid');
    }

    req.session.user = { id: user._id.toString(), username: user.username, role: 'seller', shop_name: user.shop_name };
    res.redirect('/seller/dashboard');
  } catch (err) {
    res.status(500).send('Login error');
  }
});

app.get('/seller/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

app.get('/seller/dashboard', isSeller, async (req, res) => {
  const seller = await User.findById(req.session.user.id).lean();
  const products = await Product.find({ seller_id: seller._id }).lean();
  const orders = await Order.find({ seller_id: seller._id, status: 'paid' }).lean();

  res.render('seller-dashboard', { 
    seller: { ...seller, id: seller._id.toString() }, 
    products: products.map(p => ({ ...p, id: p._id.toString() })), 
    orders 
  });
});

app.post('/seller/profile', isSeller, upload.fields([{ name: 'avatar', maxCount: 1 }, { name: 'banner', maxCount: 1 }]), async (req, res) => {
  const updateData = {};
  if (req.body.shop_name) updateData.shop_name = req.body.shop_name;
  if (req.files['avatar']) updateData.avatar = `/uploads/avatars/${req.files['avatar'][0].filename}`;
  if (req.files['banner']) updateData.banner = `/uploads/banners/${req.files['banner'][0].filename}`;

  await User.findByIdAndUpdate(req.session.user.id, updateData);
  res.redirect('/seller/dashboard');
});

app.get('/seller/product/add', isSeller, (req, res) => res.render('seller-product-add'));
app.post('/seller/product/add', isSeller, upload.fields([{ name: 'thumbnail', maxCount: 1 }, { name: 'digital_file', maxCount: 1 }]), async (req, res) => {
  try {
    const { title, price, discount_price, description, category } = req.body;
    await Product.create({
      seller_id: req.session.user.id,
      title,
      price: Number(price),
      discount_price: discount_price ? Number(discount_price) : null,
      description,
      category,
      thumbnail: `/uploads/thumbnails/${req.files['thumbnail'][0].filename}`,
      file_url: `/uploads/digital_files/${req.files['digital_file'][0].filename}`,
      file_original_name: req.files['digital_file'][0].originalname,
      status: 'pending'
    });
    res.redirect('/seller/dashboard');
  } catch (err) {
    res.status(500).send('Upload produk gagal');
  }
});

app.get('/seller/product/delete/:id', isSeller, async (req, res) => {
  await Product.deleteOne({ _id: req.params.id, seller_id: req.session.user.id });
  res.redirect('/seller/dashboard');
});

// Penarikan Saldo
app.get('/seller/withdraw', isSeller, async (req, res) => {
  const seller = await User.findById(req.session.user.id).lean();
  let methods = { manual_methods: [], instant_methods: [] };
  try {
    const resp = await axios.get(`https://app.nevapedia.com/api/withdraw/methods?apikey=${NEVAPEDIA_KEY}`);
    methods = resp.data;
  } catch (e){}
  res.render('seller-withdraw', { seller, methods });
});

app.post('/seller/withdraw', isSeller, async (req, res) => {
  const { amount, method, account_number, instant } = req.body;
  const seller = await User.findById(req.session.user.id);
  const wdAmount = Number(amount);

  if (seller.balance < wdAmount) return res.status(400).send('Saldo tidak cukup');

  try {
    const resp = await axios.get(`https://app.nevapedia.com/api/withdraw?apikey=${NEVAPEDIA_KEY}&amount=${wdAmount}&method=${method}&account_number=${account_number}&instant=${instant === 'true'}`);
    if (resp.data.success) {
      seller.balance -= wdAmount;
      await seller.save();
      res.send('<script>alert("Penarikan berhasil diajukan!"); window.location.href="/seller/dashboard";</script>');
    } else {
      res.status(400).send(resp.data.message || 'Penarikan gagal');
    }
  } catch (e) {
    res.status(500).send('Error gateway: ' + e.message);
  }
});

/* ==========================================================
   ADMIN ROUTES
========================================================== */
app.get('/admin/login', (req, res) => res.render('admin-login'));
app.post('/admin/login', (req, res) => {
  if (req.body.username === process.env.ADMIN_USERNAME && req.body.password === process.env.ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.redirect('/admin/dashboard');
  }
  res.status(401).send('Kredensial Admin Salah');
});

app.get('/admin/dashboard', isAdmin, async (req, res) => {
  const pendingProducts = await Product.find({ status: 'pending' }).lean();
  const users = await User.find().lean();
  const reports = await Report.find().lean();

  let gatewayBalance = { balance: 0, pending_balance: 0 };
  try {
    const resp = await axios.get(`https://app.nevapedia.com/api/balance?apikey=${NEVAPEDIA_KEY}`);
    gatewayBalance = resp.data;
  } catch (e){}

  res.render('admin-dashboard', { 
    pendingProducts: pendingProducts.map(p => ({ ...p, id: p._id.toString() })), 
    users: users.map(u => ({ ...u, id: u._id.toString() })), 
    reports, 
    gatewayBalance 
  });
});

app.get('/admin/product/:id/status/:status', isAdmin, async (req, res) => {
  await Product.findByIdAndUpdate(req.params.id, { status: req.params.status });
  res.redirect('/admin/dashboard');
});

app.post('/admin/seller/:id/toggle-badge', isAdmin, async (req, res) => {
  const seller = await User.findById(req.params.id);
  if (seller) {
    seller.is_verified = !seller.is_verified;
    seller.verification_type = seller.is_verified ? 'admin_grant' : null;
    await seller.save();
  }
  res.redirect('/admin/dashboard');
});

app.get('/admin/reports', isAdmin, async (req, res) => {
  const reports = await Report.find().populate('product_id').populate('seller_id').lean();
  const detailedReports = reports.map(r => ({
    ...r,
    product: r.product_id || {},
    seller: r.seller_id || {}
  }));
  res.render('admin-reports', { reports: detailedReports });
});

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => console.log(`🚀 FROVIX SHOP running on http://localhost:${PORT}`));
}

module.exports = app;