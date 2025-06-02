// src/app.js
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.get('/', (req, res) => {
  res.json({ 
    message: '🚀 SF-HubSpot Sync API is running!',
    version: '1.0.0',
    status: 'active',
    endpoints: {
      auth: {
        salesforce: '/auth/salesforce',
        salesforce_callback: '/auth/salesforce/callback',
        hubspot: '/auth/hubspot',
        hubspot_callback: '/auth/hubspot/callback'
      },
      api: {
        sync: '/api/sync',
        status: '/api/status',
        health: '/health'
      }
    },
    environment: process.env.NODE_ENV || 'development'
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Auth routes (placeholders for now)
app.get('/auth/salesforce', (req, res) => {
  res.json({ 
    message: 'Salesforce OAuth endpoint ready!',
    redirect_uri: process.env.SF_REDIRECT_URI,
    client_configured: !!process.env.SF_CLIENT_ID
  });
});

app.get('/auth/salesforce/callback', (req, res) => {
  const { code, error } = req.query;
  res.json({ 
    message: 'Salesforce OAuth callback',
    received_code: !!code,
    error: error || null
  });
});

app.get('/auth/hubspot', (req, res) => {
  res.json({ 
    message: 'HubSpot OAuth endpoint ready!',
    redirect_uri: process.env.HUBSPOT_REDIRECT_URI,
    client_configured: !!process.env.HUBSPOT_CLIENT_ID
  });
});

app.get('/auth/hubspot/callback', (req, res) => {
  const { code, error } = req.query;
  res.json({ 
    message: 'HubSpot OAuth callback',
    received_code: !!code,
    error: error || null
  });
});

// API routes
app.get('/api/sync', (req, res) => {
  res.json({ 
    message: 'Sync endpoint ready!',
    available_operations: [
      'start_sync',
      'stop_sync', 
      'sync_status',
      'sync_history'
    ]
  });
});

app.get('/api/status', (req, res) => {
  res.json({ 
    message: 'Integration status',
    integrations: {
      salesforce: {
        configured: !!process.env.SF_CLIENT_ID,
        connected: false
      },
      hubspot: {
        configured: !!process.env.HUBSPOT_CLIENT_ID,
        connected: false
      }
    }
  });
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Error:', err.stack);
  res.status(500).json({ 
    error: 'Something went wrong!',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ 
    error: 'Route not found',
    path: req.originalUrl
  });
});

// Start server
app.listen(PORT, () => {
  console.log('🚀 SF-HubSpot Sync Server Starting...');
  console.log(`📱 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔗 Server URL: http://localhost:${PORT}`);
  console.log(`📊 Health Check: http://localhost:${PORT}/health`);
  console.log('✅ Server ready for connections!');
  
  if (!process.env.SF_CLIENT_ID) {
    console.log('⚠️  Warning: SF_CLIENT_ID not set');
  }
  if (!process.env.HUBSPOT_CLIENT_ID) {
    console.log('⚠️  Warning: HUBSPOT_CLIENT_ID not set');
  }
});

module.exports = app;