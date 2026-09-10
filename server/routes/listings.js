const express = require('express');
const router = express.Router();
const Listing = require('../models/Listing');
const User = require('../models/User');
const { protect, optionalAuth } = require('../middleware/auth');

// @route   GET /api/listings
// @desc    Get all listings with filtering and pagination
// @access  Public
router.get('/', optionalAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    // Build query object
    const query = { status: 'active' };

    if (req.query.category) {
      query.category = req.query.category;
    }

    if (req.query.businessType) {
      query.businessType = req.query.businessType;
    }

    if (req.query.search) {
      query.$text = { $search: req.query.search };
    }

    if (req.query.minPrice || req.query.maxPrice) {
      query['price.amount'] = {};
      if (req.query.minPrice) query['price.amount'].$gte = parseFloat(req.query.minPrice);
      if (req.query.maxPrice) query['price.amount'].$lte = parseFloat(req.query.maxPrice);
    }

    if (req.query.location) {
      query['location.country'] = new RegExp(req.query.location, 'i');
    }

    const listings = await Listing.find(query)
      .populate('seller', 'name businessName businessType location')
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip(skip);

    const total = await Listing.countDocuments(query);

    res.json({
      listings,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Get listings error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/listings/:id
// @desc    Get single listing
// @access  Public
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const listing = await Listing.findById(req.params.id)
      .populate('seller', 'name email businessName businessType location phone bio verified');

    if (!listing) {
      return res.status(404).json({ message: 'Listing not found' });
    }

    // Increment views
    listing.views += 1;
    await listing.save();

    res.json(listing);
  } catch (error) {
    console.error('Get listing error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/listings
// @desc    Create a new listing
// @access  Private
router.post('/', protect, async (req, res) => {
  try {
    const {
      title,
      description,
      category,
      price,
      quantity,
      businessType,
      images,
      location,
      shipping
    } = req.body;

    // Check if user is a seller or both
    if (req.user.role !== 'seller' && req.user.role !== 'both') {
      return res.status(403).json({ message: 'Only sellers can create listings' });
    }

    const listing = await Listing.create({
      title,
      description,
      category,
      price,
      quantity,
      seller: req.user._id,
      businessType: businessType || req.user.businessType,
      images,
      location: location || req.user.location,
      shipping
    });

    const populatedListing = await Listing.findById(listing._id)
      .populate('seller', 'name businessName businessType');

    res.status(201).json(populatedListing);
  } catch (error) {
    console.error('Create listing error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   PUT /api/listings/:id
// @desc    Update a listing
// @access  Private
router.put('/:id', protect, async (req, res) => {
  try {
    let listing = await Listing.findById(req.params.id);

    if (!listing) {
      return res.status(404).json({ message: 'Listing not found' });
    }

    // Check ownership
    if (listing.seller.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized to update this listing' });
    }

    const {
      title,
      description,
      category,
      price,
      quantity,
      images,
      location,
      shipping,
      status
    } = req.body;

    if (title) listing.title = title;
    if (description) listing.description = description;
    if (category) listing.category = category;
    if (price) listing.price = price;
    if (quantity) listing.quantity = quantity;
    if (images) listing.images = images;
    if (location) listing.location = location;
    if (shipping) listing.shipping = shipping;
    if (status) listing.status = status;

    const updatedListing = await listing.save();
    const populatedListing = await Listing.findById(updatedListing._id)
      .populate('seller', 'name businessName businessType');

    res.json(populatedListing);
  } catch (error) {
    console.error('Update listing error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   DELETE /api/listings/:id
// @desc    Delete a listing
// @access  Private
router.delete('/:id', protect, async (req, res) => {
  try {
    const listing = await Listing.findById(req.params.id);

    if (!listing) {
      return res.status(404).json({ message: 'Listing not found' });
    }

    // Check ownership
    if (listing.seller.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized to delete this listing' });
    }

    await listing.deleteOne();
    res.json({ message: 'Listing removed' });
  } catch (error) {
    console.error('Delete listing error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/listings/seller/my-listings
// @desc    Get current user's listings
// @access  Private
router.get('/seller/my-listings', protect, async (req, res) => {
  try {
    const listings = await Listing.find({ seller: req.user._id })
      .sort({ createdAt: -1 });

    res.json(listings);
  } catch (error) {
    console.error('Get my listings error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
