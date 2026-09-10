const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { protect, optionalAuth } = require('../middleware/auth');

// @route   GET /api/users/search
// @desc    Search for users (buyers/sellers)
// @access  Public
router.get('/search', optionalAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const query = {};

    if (req.query.role) {
      query.role = req.query.role;
    }

    if (req.query.businessType) {
      query.businessType = req.query.businessType;
    }

    if (req.query.search) {
      query.$or = [
        { name: new RegExp(req.query.search, 'i') },
        { businessName: new RegExp(req.query.search, 'i') },
        { industry: new RegExp(req.query.search, 'i') }
      ];
    }

    if (req.query.industry) {
      query.industry = new RegExp(req.query.industry, 'i');
    }

    if (req.query.location) {
      query['location.country'] = new RegExp(req.query.location, 'i');
    }

    // Only return public fields
    const users = await User.find(query)
      .select('name email businessName businessType industry location bio verified createdAt')
      .limit(limit)
      .skip(skip);

    const total = await User.countDocuments(query);

    res.json({
      users,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/users/:id
// @desc    Get user profile
// @access  Public
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .select('name email businessName businessType industry location bio verified createdAt');

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json(user);
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/users/seller/:id/listings
// @desc    Get seller's active listings
// @access  Public
router.get('/seller/:id/listings', optionalAuth, async (req, res) => {
  try {
    const Listing = require('../models/Listing');
    
    const listings = await Listing.find({
      seller: req.params.id,
      status: 'active'
    })
      .populate('seller', 'name businessName businessType location')
      .sort({ createdAt: -1 });

    res.json(listings);
  } catch (error) {
    console.error('Get seller listings error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
