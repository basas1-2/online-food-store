const express = require('express');
const jwt = require('jsonwebtoken');
const Post = require('../models/Post');
const Payment = require('../models/Payment');
const Notification = require('../models/Notification');
const Stripe = require('stripe');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const router = express.Router();

// ensure uploads directory exists
const uploadsDir = path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    const name = Date.now() + '-' + Math.round(Math.random() * 1E9) + ext;
    cb(null, name);
  }
});
const upload = multer({ storage });

const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;

function getTokenFromHeader(req) {
  return req.headers.authorization || '';
}

function adminOnly(req, res, next) {
  const token = getTokenFromHeader(req);
  if (!token) return res.status(401).json({ msg: 'Not authorized' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'admin') return res.status(403).json({ msg: 'Admins only' });
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ msg: 'Invalid token' });
  }
}

// Create post (admin) - supports image upload (field name: image)
router.post('/create', adminOnly, upload.single('image'), async (req, res) => {
  try {
    const data = { ...req.body, createdBy: req.user.id };
    if (req.file) {
      // save a public path
      data.image = '/uploads/' + req.file.filename;
    }
    const post = new Post(data);
    await post.save();
    res.json({ msg: 'Post created' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server error' });
  }
});

// Edit post (admin)
router.put('/:id', adminOnly, async (req, res) => {
  try {
    await Post.findByIdAndUpdate(req.params.id, req.body);
    res.json({ msg: 'Post updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server error' });
  }
});

// Delete post (admin)
router.delete('/:id', adminOnly, async (req, res) => {
  try {
    await Post.findByIdAndDelete(req.params.id);
    res.json({ msg: 'Post deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server error' });
  }
});

// Get posts (public)
router.get('/', async (req, res) => {
  try {
    const posts = await Post.find().sort({ createdAt: -1 });
    res.json(posts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server error' });
  }
});

// (single post route moved below notifications to avoid route conflicts)

// Old simple pay endpoint (kept for compatibility) - records payment without Stripe
router.post('/:id/pay', async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ msg: 'Post not found' });

    const { quantity, buyerId, buyerName, buyerEmail } = req.body;
    const qty = parseInt(quantity, 10) || 1;
    if (qty < 1) return res.status(400).json({ msg: 'Invalid quantity' });

    const amount = (post.price || 0) * qty;

    const payment = new Payment({ postId: post._id.toString(), buyerId, buyerName, buyerEmail, quantity: qty, amount });
    await payment.save();

    // create admin notification
    const adminNote = new Notification({
      recipient: 'admin',
      message: `Payment received for ${post.title}`,
      meta: { postId: post._id.toString(), buyerId, buyerName, buyerEmail, quantity: qty, amount }
    });
    await adminNote.save();

    // create buyer notification
    const buyerNote = new Notification({
      recipient: buyerId || buyerEmail || 'unknown',
      message: `Payment successful for ${post.title}`,
      meta: { postId: post._id.toString(), quantity: qty, amount }
    });
    await buyerNote.save();

    res.json({ msg: 'Payment recorded', paymentId: payment._id, amount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server error' });
  }
});

// Create Stripe Checkout Session
router.post('/:id/create-checkout-session', async (req, res) => {
  if (!stripe) return res.status(500).json({ msg: 'Stripe not configured on server' });
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ msg: 'Post not found' });

    const { quantity = 1, buyerId, buyerName, buyerEmail } = req.body;
    const qty = parseInt(quantity, 10) || 1;

    const origin = process.env.APP_URL || req.get('origin') || `http://localhost:${process.env.PORT||3030}`;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: post.title, description: post.content },
          unit_amount: Math.round((post.price || 0) * 100)
        },
        quantity: qty
      }],
      mode: 'payment',
      success_url: `${origin}/payment-success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/`,
      metadata: { postId: post._id.toString(), buyerId: buyerId || '', buyerName: buyerName || '', buyerEmail: buyerEmail || '', quantity: String(qty) }
    });

    res.json({ sessionId: session.id, publishableKey: process.env.STRIPE_PUBLISHABLE_KEY });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server error creating Stripe session' });
  }
});

// Confirm Stripe payment after redirect (client passes sessionId)
router.post('/confirm-payment', async (req, res) => {
  if (!stripe) return res.status(500).json({ msg: 'Stripe not configured on server' });
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ msg: 'Missing sessionId' });

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (!session) return res.status(404).json({ msg: 'Session not found' });

    // Only process paid sessions
    if (session.payment_status !== 'paid') return res.status(400).json({ msg: 'Payment not completed' });

    const meta = session.metadata || {};
    const post = await Post.findById(meta.postId);
    if (!post) return res.status(404).json({ msg: 'Post not found' });

    const qty = parseInt(meta.quantity || '1', 10) || 1;
    const amount = (session.amount_total || (post.price * 100 * qty)) / 100;

    // Avoid duplicate payments: check if a Payment already exists with session id in meta
    const existing = await Payment.findOne({ 'postId': meta.postId, 'buyerEmail': meta.buyerEmail, 'amount': amount, 'quantity': qty });
    if (existing) return res.json({ msg: 'Already recorded', paymentId: existing._id, amount });

    const payment = new Payment({ postId: meta.postId, buyerId: meta.buyerId, buyerName: meta.buyerName, buyerEmail: meta.buyerEmail, quantity: qty, amount });
    await payment.save();

    const adminNote = new Notification({ recipient: 'admin', message: `Payment received for ${post.title}`, meta: { postId: meta.postId, buyerId: meta.buyerId, buyerName: meta.buyerName, buyerEmail: meta.buyerEmail, quantity: qty, amount } });
    await adminNote.save();

    const buyerNote = new Notification({ recipient: meta.buyerId || meta.buyerEmail || 'unknown', message: `Payment successful for ${post.title}`, meta: { postId: meta.postId, quantity: qty, amount } });
    await buyerNote.save();

    res.json({ msg: 'Payment recorded', paymentId: payment._id, amount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Error confirming payment' });
  }
});

// Admin: get notifications
router.get('/notifications/admin', adminOnly, async (req, res) => {
  try {
    const notes = await Notification.find({ recipient: 'admin' }).sort({ createdAt: -1 });
    res.json(notes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server error' });
  }
});

// User: get notifications (by user id or email)
router.get('/notifications/user/:who', async (req, res) => {
  try {
    const who = req.params.who;
    const notes = await Notification.find({ recipient: who }).sort({ createdAt: -1 });
    res.json(notes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server error' });
  }
});

// Mark notification as read
router.post('/notifications/:id/read', async (req, res) => {
  try {
    const id = req.params.id;
    const note = await Notification.findByIdAndUpdate(id, { read: true }, { new: true });
    if (!note) return res.status(404).json({ msg: 'Notification not found' });
    res.json({ msg: 'Marked read', note });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server error' });
  }
});

// Get single post by id (public)
router.get('/:id', async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ msg: 'Post not found' });
    res.json(post);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server error' });
  }
});

module.exports = router;
