const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  postId: { type: String, required: true },
  buyerId: { type: String, required: true },
  buyerName: { type: String },
  buyerEmail: { type: String },
  quantity: { type: Number, required: true, min: 1 },
  amount: { type: Number, required: true },
}, { timestamps: true });

module.exports = mongoose.model('Payment', paymentSchema);
