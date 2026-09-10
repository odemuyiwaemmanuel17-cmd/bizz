const mongoose = require('mongoose');

const listingSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'Listing title is required'],
    trim: true
  },
  description: {
    type: String,
    required: [true, 'Description is required'],
    maxlength: 2000
  },
  category: {
    type: String,
    required: true,
    enum: ['raw-materials', 'manufacturing', 'wholesale', 'retail', 'services', 'technology', 'equipment', 'other']
  },
  price: {
    amount: {
      type: Number,
      required: true,
      min: 0
    },
    currency: {
      type: String,
      default: 'USD',
      uppercase: true
    },
    negotiable: {
      type: Boolean,
      default: false
    }
  },
  quantity: {
    available: {
      type: Number,
      default: 1
    },
    unit: {
      type: String,
      default: 'piece'
    },
    minOrderQuantity: {
      type: Number,
      default: 1
    }
  },
  seller: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  businessType: {
    type: String,
    enum: ['small', 'large', 'enterprise'],
    required: true
  },
  images: [{
    url: String,
    caption: String
  }],
  location: {
    city: String,
    state: String,
    country: String
  },
  shipping: {
    available: {
      type: Boolean,
      default: false
    },
    regions: [String],
    cost: Number
  },
  status: {
    type: String,
    enum: ['active', 'inactive', 'sold', 'pending'],
    default: 'active'
  },
  views: {
    type: Number,
    default: 0
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

listingSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

listingSchema.index({ title: 'text', description: 'text' });
listingSchema.index({ category: 1, status: 1 });
listingSchema.index({ seller: 1 });

module.exports = mongoose.model('Listing', listingSchema);
