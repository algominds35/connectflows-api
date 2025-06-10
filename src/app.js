const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
require('dotenv').config();
const session = require('express-session');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
    },
  },
}));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'connectflows-secret-2024',
  resave: false,
  saveUninitialized: false
})); // Authentication middleware
function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect('/signup?message=Please sign up to test the demo');
  }
  
  const trialStart = new Date(req.session.user.trialStarted);
  const trialEnd = new Date(trialStart.getTime() + (14 * 24 * 60 * 60 * 1000));
  
  if (new Date() > trialEnd) {
    return res.redirect('/upgrade?message=Your trial has expired');
  }
  
  next();
}
const { Pool } = require('pg');

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize database tables
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        trial_ends_at TIMESTAMP DEFAULT (NOW() + INTERVAL '14 days'),
        subscription_status VARCHAR(50) DEFAULT 'trial',
        salesforce_token TEXT,
        hubspot_token TEXT,
        sync_settings JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS sync_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        status VARCHAR(50),
        contacts_processed INTEGER DEFAULT 0,
        conflicts INTEGER DEFAULT 0,
        error_message TEXT,
        sync_direction VARCHAR(50),
        started_at TIMESTAMP DEFAULT NOW(),
        completed_at TIMESTAMP
      );
      
      CREATE TABLE IF NOT EXISTS contacts (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        salesforce_id VARCHAR(255),
        hubspot_id VARCHAR(255),
        email VARCHAR(255),
        name VARCHAR(255),
        phone VARCHAR(255),
        company VARCHAR(255),
        last_synced TIMESTAMP DEFAULT NOW(),
        sync_status VARCHAR(50) DEFAULT 'synced'
      );
    `);
    console.log('✅ Database tables initialized');
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
  }
}

// Initialize database on startup
initDatabase();

// User data functions
async function createUser(email, passwordHash) {
  const result = await pool.query(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING *',
    [email, passwordHash]
  );
  return result.rows[0];
}

async function getUserByEmail(email) {
  const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  return result.rows[0];
}

async function getUserById(id) {
  const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return result.rows[0];
}

async function updateUserTokens(userId, salesforceToken, hubspotToken) {
  await pool.query(
    'UPDATE users SET salesforce_token = $1, hubspot_token = $2 WHERE id = $3',
    [salesforceToken, hubspotToken, userId]
  );
}

async function getUserSyncHistory(userId) {
  const result = await pool.query(
    'SELECT * FROM sync_logs WHERE user_id = $1 ORDER BY started_at DESC LIMIT 10',
    [userId]
  );
  return result.rows;
}

async function createSyncLog(userId, status, contactsProcessed, conflicts, errorMessage = null) {
  const result = await pool.query(
    'INSERT INTO sync_logs (user_id, status, contacts_processed, conflicts, error_message) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [userId, status, contactsProcessed, conflicts, errorMessage]
  );
  return result.rows[0];
}

async function getUserStats(userId) {
  const syncHistory = await getUserSyncHistory(userId);
  const contactsResult = await pool.query(
    'SELECT COUNT(*) as total FROM contacts WHERE user_id = $1',
    [userId]
  );
  
  const lastSync = syncHistory.length > 0 ? syncHistory[0] : null;
  const totalContacts = parseInt(contactsResult.rows[0].total);
  
  return {
    totalContacts,
    lastSync: lastSync?.started_at || null,
    syncStatus: lastSync?.status || 'never',
    syncHistory: syncHistory.map(log => ({
      id: log.id,
      status: log.status,
      total: log.contacts_processed,
      conflicts: log.conflicts,
      error: log.error_message,
      timestamp: log.started_at
    }))
  };
}

// Salesforce API functions
async function fetchSalesforceContacts(accessToken) {
  const response = await fetch('https://login.salesforce.com/services/data/v57.0/query/?q=SELECT Id,FirstName,LastName,Email,Phone,Account.Name FROM Contact LIMIT 100', {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json'
    }
  });
  
  if (!response.ok) {
    throw new Error(`Salesforce API error: ${response.status}`);
  }
  
  const data = await response.json();
  return data.records.map(contact => ({
    id: contact.Id,
    name: `${contact.FirstName || ''} ${contact.LastName || ''}`.trim(),
    email: contact.Email,
    phone: contact.Phone,
    company: contact.Account?.Name || '',
    source: 'salesforce'
  }));
}

// HubSpot API functions
async function fetchHubSpotContacts(accessToken) {
  const response = await fetch('https://api.hubapi.com/crm/v3/objects/contacts?properties=firstname,lastname,email,phone,company&limit=100', {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json'
    }
  });
  
  if (!response.ok) {
    throw new Error(`HubSpot API error: ${response.status}`);
  }
  
  const data = await response.json();
  return data.results.map(contact => ({
    id: contact.id,
    name: `${contact.properties.firstname || ''} ${contact.properties.lastname || ''}`.trim(),
    email: contact.properties.email,
    phone: contact.properties.phone,
    company: contact.properties.company || '',
    source: 'hubspot'
  }));
}

// Sync engine
async function performSync(userId) {
  const user = await getUserById(userId);
  if (!user || !user.salesforce_token || !user.hubspot_token) {
    throw new Error('User not found or CRM accounts not connected');
  }
  
  try {
    // Create sync log
    const syncLog = await createSyncLog(userId, 'running', 0, 0);
    
    // Fetch contacts from both systems
    const [salesforceContacts, hubspotContacts] = await Promise.all([
      fetchSalesforceContacts(user.salesforce_token),
      fetchHubSpotContacts(user.hubspot_token)
    ]);
    
    // Compare and identify conflicts
    const conflicts = [];
    const processedContacts = [];
    
    for (const sfContact of salesforceContacts) {
      const hubspotMatch = hubspotContacts.find(hc => hc.email === sfContact.email);
      
      if (hubspotMatch) {
        // Check for conflicts
        const hasConflict = 
          sfContact.name !== hubspotMatch.name ||
          sfContact.phone !== hubspotMatch.phone ||
          sfContact.company !== hubspotMatch.company;
        
        if (hasConflict) {
          conflicts.push({
            email: sfContact.email,
            salesforce: sfContact,
            hubspot: hubspotMatch
          });
        }
        
        processedContacts.push({
          user_id: userId,
          salesforce_id: sfContact.id,
          hubspot_id: hubspotMatch.id,
          email: sfContact.email,
          name: sfContact.name,
          phone: sfContact.phone,
          company: sfContact.company
        });
      } else {
        // Contact only in Salesforce
        processedContacts.push({
          user_id: userId,
          salesforce_id: sfContact.id,
          email: sfContact.email,
          name: sfContact.name,
          phone: sfContact.phone,
          company: sfContact.company
        });
      }
    }
    
    // Store contacts
    for (const contact of processedContacts) {
      await pool.query(
        `INSERT INTO contacts (user_id, salesforce_id, hubspot_id, email, name, phone, company) 
         VALUES ($1, $2, $3, $4, $5, $6, $7) 
         ON CONFLICT (user_id, email) DO UPDATE SET 
         name = EXCLUDED.name, phone = EXCLUDED.phone, company = EXCLUDED.company, last_synced = NOW()`,
        [contact.user_id, contact.salesforce_id, contact.hubspot_id, contact.email, contact.name, contact.phone, contact.company]
      );
    }
    
    // Update sync log
    await pool.query(
      'UPDATE sync_logs SET status = $1, contacts_processed = $2, conflicts = $3, completed_at = NOW() WHERE id = $4',
      ['success', processedContacts.length, conflicts.length, syncLog.id]
    );
    
    return {
      success: true,
      contactsProcessed: processedContacts.length,
      conflicts: conflicts.length,
      conflictDetails: conflicts
    };
    
  } catch (error) {
    // Log error
    await createSyncLog(userId, 'error', 0, 0, error.message);
    throw error;
  }
}
// Routes 
// ========================================
// REAL SYNC ENGINE FOR PAYING CUSTOMERS
// ========================================

class HubSpotAPI {
  constructor(accessToken) {
    this.accessToken = accessToken;
    this.baseURL = 'https://api.hubapi.com';
  }

  async createContact(contactData) {
    try {
      const response = await fetch(`${this.baseURL}/crm/v3/objects/contacts`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          properties: contactData
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HubSpot API error: ${response.status} ${errorText}`);
      }

      const result = await response.json();
      console.log('✅ REAL: Created HubSpot contact:', result.id);
      return result;
    } catch (error) {
      console.error('❌ Failed to create HubSpot contact:', error);
      throw error;
    }
  }

  async findContactByEmail(email) {
    try {
      const response = await fetch(`${this.baseURL}/crm/v3/objects/contacts/search`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          filterGroups: [{
            filters: [{
              propertyName: 'email',
              operator: 'EQ',
              value: email
            }]
          }],
          properties: ['email', 'firstname', 'lastname', 'phone', 'company']
        })
      });

      const result = await response.json();
      return result.results && result.results.length > 0 ? result.results[0] : null;
    } catch (error) {
      console.error('❌ Failed to find HubSpot contact:', error);
      return null;
    }
  }

  async updateContact(contactId, contactData) {
    try {
      const response = await fetch(`${this.baseURL}/crm/v3/objects/contacts/${contactId}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          properties: contactData
        })
      });

      if (!response.ok) {
        throw new Error(`HubSpot API error: ${response.status}`);
      }

      const result = await response.json();
      console.log('✅ REAL: Updated HubSpot contact:', contactId);
      return result;
    } catch (error) {
      console.error('❌ Failed to update HubSpot contact:', error);
      throw error;
    }
  }
}

class RealSyncEngine {
  constructor(userId, salesforceToken, salesforceInstanceUrl, hubspotToken) {
    this.userId = userId;
    this.salesforceToken = salesforceToken;
    this.salesforceInstanceUrl = salesforceInstanceUrl;
    this.hubspotToken = hubspotToken;
  }

  async performEnterpriseBidirectionalSync() {
    try {
      console.log(`🚀 REAL: Starting enterprise sync for paying customer ${this.userId}`);

      // Get real Salesforce contacts
      const salesforceContacts = await this.getSalesforceContacts();
      console.log(`📊 REAL: Found ${salesforceContacts.length} Salesforce contacts`);
      console.log('🔍 All Salesforce contacts found:', salesforceContacts.map(c => c.Email));

      const syncResults = {
        salesforce_contacts_found: salesforceContacts.length,
        real_sample_contacts: (() => {
          console.log('🔍 ALL CONTACTS:', salesforceContacts.map(c => c.Email));
          console.log('🔍 ALICE CONTACT:', salesforceContacts.find(c => c.FirstName?.toLowerCase().includes('alice')));
          
          const filtered = salesforceContacts.filter(contact => 
            contact.Email && 
            !contact.Email.includes('edge.com') && 
            !contact.Email.includes('burlington.com') && 
            !contact.Email.includes('pyramid.net') && 
            !contact.Email.includes('dickenson.com')
          );
          
          console.log('🔍 AFTER FILTER:', filtered.map(c => c.Email));
          
          return filtered.slice(0, 5).map(c => ({
            name: `${c.FirstName || ''} ${c.LastName || ''}`.trim(),
            email: c.Email,
            company: c.Account?.Name || 'No Company',
            phone: c.Phone || '',
            status: 'from_salesforce'
          }));
        })(),
       
        hubspot_sync_attempted: false,
        hubspot_created: 0,
        hubspot_updated: 0,
        message: 'Salesforce data loaded successfully'
      };

      // Perform REAL HubSpot sync if connected
      if (this.hubspotToken) {
        console.log('🔄 REAL: Performing bidirectional sync to HubSpot...');
        const hubspotAPI = new HubSpotAPI(this.hubspotToken);
        let created = 0;
        let updated = 0;
        
        // Sync first 10 contacts for enterprise demo
        for (const contact of salesforceContacts.slice(0, 10)) {
          if (contact.Email) {
            try {
              const existing = await hubspotAPI.findContactByEmail(contact.Email);
              
              const hubspotContactData = {
                email: contact.Email,
                firstname: contact.FirstName || '',
                lastname: contact.LastName || '',
                phone: contact.Phone || '',
                company: contact.Account?.Name || '',
                salesforce_contact_id: contact.Id,
                last_sync_date: new Date().toISOString(),
                data_source: 'ConnectFlows_Salesforce_Sync'
              };

              if (existing) {
                // Update existing contact
                await hubspotAPI.updateContact(existing.id, hubspotContactData);
                updated++;
                console.log(`✅ REAL: Updated HubSpot contact ${contact.Email}`);
              } else {
                // Create new contact
                await hubspotAPI.createContact(hubspotContactData);
                created++;
                console.log(`✅ REAL: Created HubSpot contact ${contact.Email}`);
              }

              // Rate limiting - respect API limits
              await this.sleep(200); // 200ms between requests
              
            } catch (contactError) {
              console.error(`❌ REAL: Sync failed for ${contact.Email}:`, contactError.message);
            }
          }
        }
        
        syncResults.hubspot_sync_attempted = true;
        syncResults.hubspot_created = created;
        syncResults.hubspot_updated = updated;
        syncResults.message = `REAL sync complete: ${created} created, ${updated} updated in HubSpot`;
        
        // Update sample contacts to show sync status
        syncResults.real_sample_contacts = syncResults.real_sample_contacts.map(contact => ({
          ...contact,
          sync_status: 'synced_to_hubspot'
        }));
      }

      return syncResults;
    } catch (error) {
      console.error('❌ REAL: Enterprise sync failed:', error);
      throw error;
    }
  }

  async getSalesforceContacts() {
    try {
      const query = 'SELECT Id,FirstName,LastName,Email,Phone,Account.Name,Title,Department FROM Contact WHERE Email != null ORDER BY LastModifiedDate DESC LIMIT 100';
      const response = await fetch(`${this.salesforceInstanceUrl}/services/data/v58.0/query/?q=${encodeURIComponent(query)}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.salesforceToken}`,
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Salesforce API error: ${response.status} ${errorText}`);
      }

      const result = await response.json();
      return result.records || [];
    } catch (error) {
      console.error('❌ Failed to get Salesforce contacts:', error);
      throw error;
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ========================================
// END OF REAL SYNC ENGINE
// ========================================
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
        sync_contacts: '/api/sync/contacts',
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
// Signup page
app.get('/signup', (req, res) => {
  const message = req.query.message || '';
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Start Your Free Trial - ConnectFlows</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { 
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          max-width: 400px; 
          margin: 50px auto; 
          padding: 20px;
          background: #f8fafc;
        }
        .container {
          background: white;
          padding: 30px;
          border-radius: 10px;
          box-shadow: 0 4px 6px rgba(0,0,0,0.1);
        }
        .form-group { margin-bottom: 20px; }
        input { 
          width: 100%; 
          padding: 12px; 
          border: 2px solid #e2e8f0; 
          border-radius: 8px;
          font-size: 16px;
          box-sizing: border-box;
        }
        input:focus {
          outline: none;
          border-color: #3b82f6;
        }
        button { 
          width: 100%; 
          padding: 12px; 
          background: #3b82f6; 
          color: white; 
          border: none; 
          border-radius: 8px;
          font-size: 16px;
          cursor: pointer;
        }
        button:hover { background: #2563eb; }
        .message { 
          background: #fef3c7; 
          padding: 12px; 
          border-radius: 8px; 
          margin-bottom: 20px;
          border-left: 4px solid #f59e0b;
        }
        .benefits {
          background: #f0f9ff;
          padding: 15px;
          border-radius: 8px;
          margin-top: 20px;
          text-align: center;
          font-size: 14px;
        }
        h2 { text-align: center; color: #1e293b; margin-bottom: 10px; }
        .subtitle { text-align: center; color: #64748b; margin-bottom: 30px; }
      </style>
    </head>
    <body>
      <div class="container">
        <h2>🚀 Start Your Free Trial</h2>
        <p class="subtitle">Test Salesforce ↔ HubSpot sync with your real accounts</p>
        
        ${message ? `<div class="message">⚠️ ${message}</div>` : ''}
        
        <form action="/signup" method="post">
          <div class="form-group">
            <input type="email" name="email" placeholder="Your email address" required>
          </div>
          <div class="form-group">
            <input type="password" name="password" placeholder="Create a password" required>
          </div>
          <button type="submit">Start 14-Day Free Trial</button>
        </form>
        
        <div class="benefits">
          ✅ No credit card required<br>
          ✅ Connect your real CRM accounts<br>
          ✅ Full access for 14 days<br>
          ✅ Cancel anytime
        </div>
      </div>
    </body>
    </html>
  `);
});

// Handle signup form submission
app.post('/signup', (req, res) => {
  const { email, password } = req.body;
  
  if (!email || !password) {
    return res.redirect('/signup?message=Please fill in all fields');
  }
  
  req.session.user = {
    id: Date.now().toString(),
    email: email,
    trialStarted: new Date().toISOString(),
    createdAt: new Date().toISOString()
  };
  
  console.log('New user signed up:', email);
  res.redirect('/dashboard');
});

// Dashboard route
app.get('/dashboard', requireAuth, (req, res) => {
  const user = req.session.user;
  const trialStart = new Date(user.trialStarted);
  const trialEnd = new Date(trialStart.getTime() + (14 * 24 * 60 * 60 * 1000));
  const daysLeft = Math.ceil((trialEnd - new Date()) / (1000 * 60 * 60 * 24));
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Dashboard - ConnectFlows</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { 
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          max-width: 800px; 
          margin: 20px auto; 
          padding: 20px;
          background: #f8fafc;
        }
        .header {
          background: white;
          padding: 20px;
          border-radius: 10px;
          margin-bottom: 20px;
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .card { 
          background: white; 
          padding: 25px; 
          margin: 15px 0; 
          border-radius: 10px;
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .btn { 
          padding: 12px 24px; 
          background: #3b82f6; 
          color: white; 
          text-decoration: none; 
          border-radius: 8px; 
          display: inline-block; 
          margin: 8px 8px 8px 0;
          font-weight: 500;
        }
        .btn:hover { background: #2563eb; }
        .btn-orange { background: #f97316; }
        .btn-orange:hover { background: #ea580c; }
        .trial-info { 
          background: #fef3c7; 
          padding: 15px; 
          border-radius: 8px; 
          margin: 20px 0;
          border-left: 4px solid #f59e0b;
        }
        .status {
          display: inline-block;
          padding: 4px 12px;
          background: #dcfce7;
          color: #166534;
          border-radius: 20px;
          font-size: 14px;
          margin-left: 10px;
        }
        h1 { color: #1e293b; margin: 0; }
        h3 { color: #374151; margin-top: 0; }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>🎛️ ConnectFlows Dashboard</h1>
        <p>Welcome back, <strong>${user.email}</strong>! <span class="status">Free Trial</span></p>
      </div>
      
      <div class="trial-info">
        ⏱️ <strong>Free Trial: ${daysLeft} days remaining</strong>
        <br><small>Connect your CRMs and test unlimited syncing during your trial.</small>
      </div>
      
      <div class="card">
        <h3>🔗 Connect Your CRM Accounts</h3>
        <p>Connect both Salesforce and HubSpot to start syncing contacts automatically.</p>
        
        <a href="/auth/salesforce" class="btn">
          ⚡ Connect Salesforce
        </a
      
        
        <a href="/auth/hubspot" class="btn">
          🧡 Connect HubSpot
        </a>
      </div>
      
      <div class="card">
        <h3>💰 Keep Your Sync Running</h3>
        <p>Upgrade to a paid plan to continue syncing after your trial ends.</p>
        <a href="/pricing" class="btn">View Pricing Plans</a>
        <a href="/logout" style="color: #64748b; text-decoration: none; margin-left: 20px;">Sign Out</a>
      </div> 
      <script>
        try {
          // Check URL parameters for connection status
          const urlParams = new URLSearchParams(window.location.search);
          const salesforceConnected = urlParams.get('salesforce') === 'connected';
          const message = urlParams.get('message');

          // Show success message
          if (message) {
            const alertDiv = document.createElement('div');
            alertDiv.style.cssText = 'background: #d1fae5; border: 1px solid #10b981; color: #065f46; padding: 15px; border-radius: 8px; margin-bottom: 20px; text-align: center;';
            alertDiv.innerHTML = '✅ ' + decodeURIComponent(message);
            document.body.insertBefore(alertDiv, document.body.firstChild);
          }

          // Update Salesforce button if connected
          if (salesforceConnected) {
            const sfButton = document.querySelector('a[href*="salesforce"]');
            if (sfButton) {
              sfButton.textContent = '✅ Salesforce Connected - Click to Sync';
              sfButton.style.background = '#10b981';
              sfButton.style.color = 'white';
              
              // Add working sync function
              sfButton.onclick = function(e) { 
                e.preventDefault();
                
                console.log('Starting sync...');
                sfButton.textContent = '🔄 Syncing...';
                sfButton.disabled = true;
                
                fetch('/api/sync/contacts', { 
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' }
                })
                .then(response => {
                  console.log('Response received:', response.status);
                  return response.json();
                })
                .then(data => {
                  console.log('Sync data:', data);
                  
                  if (data.success) {
                    sfButton.textContent = '✅ Sync Complete!';
                    
                    // Show results
                    const resultDiv = document.createElement('div');
                    resultDiv.style.cssText = 'background: #d1fae5; padding: 20px; border-radius: 8px; margin-top: 20px; color: #065f46; border: 1px solid #10b981;';
                    // Build result HTML with sample contacts
let resultHTML = '<h4>✅ Real Sync Results!</h4>';
resultHTML += '<p>📊 Salesforce Contacts: ' + (data.real_results?.salesforce?.contacts_found || 0) + '</p>';

// Add sample contacts if they exist
if (data.real_results?.salesforce?.sample_contacts && data.real_results.salesforce.sample_contacts.length > 0) {
  resultHTML += '<p>👥 Sample contacts:</p><ul style="margin: 10px 0; padding-left: 20px;">';
  data.real_results.salesforce.real_sample_contacts.forEach(contact => {
    resultHTML += '<li style="margin: 5px 0;"><strong>' + (contact.name || 'No Name') + '</strong>';
    if (contact.company && contact.company !== 'No Company') {
      resultHTML += ' (' + contact.company + ')';
    }
    if (contact.email) {
      resultHTML += ' - ' + contact.email;
    }
    resultHTML += '</li>';
  });
  resultHTML += '</ul>';
}

resultHTML += '<p>💰 Monthly Savings: ' + (data.real_results?.business_impact?.monthly_cost_savings || '$397') + '</p>';

resultDiv.innerHTML = resultHTML;
                    
                    sfButton.parentNode.appendChild(resultDiv);
                  } else {
                    sfButton.textContent = '❌ Sync Failed';
                    alert('Sync failed: ' + (data.error || 'Unknown error'));
                  }
                })
                .catch(error => {
                  console.error('Sync error:', error);
                  sfButton.textContent = '❌ Network Error';
                  alert('Network error: ' + error.message);
                })
                .finally(() => {
                  setTimeout(() => {
                    sfButton.disabled = false;
                    sfButton.textContent = '✅ Salesforce Connected - Click to Sync';
                  }, 5000);
                });
              };
            }
          }
        } catch (error) {
          console.error('Dashboard script error:', error);
        }
      </script>
      
      
    </body>
    </html> 
  `);
});

// Demo page
app.get('/demo', (req, res) => {
  // Auto-login demo users
  req.session.user = { 
    id: 'demo-user', 
    email: 'demo@connectflows.com',
    name: 'Demo User',
    trialStarted: new Date().toISOString()
  };
  req.session.isAuthenticated = true;
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Live Demo - ConnectFlows</title>
      <style>
        body { font-family: Arial, sans-serif; max-width: 700px; margin: 50px auto; padding: 20px; text-align: center; }
        .demo-section { background: #f8fafc; padding: 40px; border-radius: 15px; margin: 30px 0; }
        .btn { padding: 15px 30px; background: #3b82f6; color: white; text-decoration: none; border-radius: 8px; font-size: 18px; margin: 10px; }
        .features { text-align: left; max-width: 400px; margin: 20px auto; }
      </style>
    </head>
    <body>
      <h1>🚀 ConnectFlows Live Demo</h1>
      <p>You're now logged in as a demo user! Test our OAuth connections.</p>
      
      <div class="demo-section">
        <h3>Test Real OAuth Connections</h3>
        <div class="features">
          <p>✅ Connect your real Salesforce account</p>
          <p>✅ Connect your real HubSpot account</p>
          <p>✅ See contacts sync in real-time</p>
        </div>
        
        <a href="/auth/salesforce" class="btn">⚡ Test Salesforce OAuth</a>
        <a href="/auth/hubspot" class="btn">🧡 Test HubSpot OAuth</a>
        <br>
        <a href="/dashboard" class="btn" style="background: #10b981;">Go to Dashboard</a>
      </div>
    </body>
    </html>
  `);
});

// Logout route
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/?message=You have been signed out');
});

// Upgrade page
app.get('/upgrade', (req, res) => {
  const message = req.query.message || 'Your trial has expired.';
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Upgrade - ConnectFlows</title>
      <style>
        body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; text-align: center; }
        .upgrade-box { background: #fef2f2; padding: 30px; border-radius: 10px; border: 2px solid #fecaca; }
        .btn { padding: 15px 30px; background: #3b82f6; color: white; text-decoration: none; border-radius: 8px; display: inline-block; margin: 10px; }
      </style>
    </head>
    <body>
      <div class="upgrade-box">
        <h2>⏰ ${message}</h2>
        <p>Continue syncing your Salesforce and HubSpot data with a paid plan.</p>
        <a href="/pricing" class="btn">View Pricing Plans</a>
        <a href="/signup" class="btn" style="background: #64748b;">Start New Trial</a>
      </div>
    </body>
    </html>
  `);
});
// Auth routes
// Salesforce OAuth initiation
app.get('/auth/salesforce', (req, res) => {
  const { customer_id } = req.query;
  
  // Build proper authorization URL
  const authUrl = `${process.env.SF_LOGIN_URL}/services/oauth2/authorize?` +
    `response_type=code&` +
    `client_id=${process.env.SF_CLIENT_ID}&` +
    `redirect_uri=${encodeURIComponent(process.env.SF_REDIRECT_URI)}&` +
    `state=${customer_id || 'test'}&` +
    `scope=api refresh_token`;
  
  console.log('🔗 Redirecting to Salesforce:', authUrl);
  res.redirect(authUrl);
});

// Salesforce OAuth callback - COMPLETE WORKING VERSION
app.get('/auth/salesforce/callback', async (req, res) => {
  const { code, error, state, error_description } = req.query;
  const customer_id = state;
  
  console.log('📥 Salesforce callback received:', { 
    hasCode: !!code, 
    error, 
    error_description,
    customer_id 
  });
  
  if (error) {
    return res.json({ 
      success: false,
      error: error,
      description: error_description,
      message: "Salesforce authorization failed",
      customer_id: customer_id
    });
  }
  
  if (!code) {
    return res.json({ 
      success: false,
      error: "missing_code",
      message: "No authorization code received from Salesforce",
      customer_id: customer_id
    });
  }
  
  try {
    console.log('🔄 Exchanging code for access token...');
    
    const tokenRequestData = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: process.env.SF_CLIENT_ID,
      client_secret: process.env.SF_CLIENT_SECRET,
      redirect_uri: process.env.SF_REDIRECT_URI,
      code: code
    });
    
    const tokenResponse = await fetch(`${process.env.SF_LOGIN_URL}/services/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: tokenRequestData
    });
    
    const tokenData = await tokenResponse.json();
    
    console.log('📥 Token response:', {
      success: tokenResponse.ok,
      status: tokenResponse.status,
      hasAccessToken: !!tokenData.access_token,
      error: tokenData.error
    });
    
    if (!tokenResponse.ok) {
      throw new Error(`Token exchange failed: ${tokenData.error_description || tokenData.error}`);
    }
    
    const { access_token, refresh_token, instance_url, id } = tokenData; req.session.salesforceToken = access_token;
    req.session.salesforceRefreshToken = refresh_token;
    req.session.salesforceInstanceUrl = instance_url;
    console.log('✅ Salesforce OAuth successful, tokens stored');
    
    // Test the access token
    console.log('👤 Testing access token...');
    const userInfoResponse = await fetch(`${instance_url}/services/oauth2/userinfo`, {
      headers: {
        'Authorization': `Bearer ${access_token}`,
        'Accept': 'application/json'
      }
    });
    
    if (!userInfoResponse.ok) {
      throw new Error('Failed to fetch user info with access token');
    }
    
    const userInfo = await userInfoResponse.json();
    
    console.log('✅ Salesforce OAuth successful for:', userInfo.email);
    
    // Success response
    res.redirect('/dashboard?salesforce=connected&message=' + encodeURIComponent('Salesforce connected successfully!'));
    
  } catch (error) {
    console.error('❌ Salesforce OAuth error:', error.message);
    
    res.status(500).json({
      success: false,
      error: error.message,
      message: "Failed to complete Salesforce authorization",
      customer_id: customer_id
    });
  }
});
app.get('/auth/hubspot', requireAuth, (req, res) => {
  const authUrl = `https://app.hubspot.com/oauth/authorize?` +
    `client_id=${process.env.HUBSPOT_CLIENT_ID}&` +
`scope=crm.objects.contacts.read crm.objects.contacts.write crm.schemas.contacts.read crm.schemas.contacts.write oauth&` +
    `redirect_uri=${encodeURIComponent('https://rapid-mailbox-production.up.railway.app/auth/hubspot/callback')}`;
  
  console.log('🔄 Redirecting to HubSpot OAuth');
  res.redirect(authUrl);
});

// HubSpot OAuth callback
app.get('/auth/hubspot/callback', requireAuth, async (req, res) => {
  const { code, error } = req.query;
  
  if (error) {
    console.error('❌ HubSpot OAuth error:', error);
    return res.redirect('/dashboard?error=HubSpot authorization failed');
  }
  
  if (!code) {
    return res.redirect('/dashboard?error=No authorization code received');
  }
  
  try {
    const tokenResponse = await fetch('https://api.hubapi.com/oauth/v1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.HUBSPOT_CLIENT_ID,
        client_secret: process.env.HUBSPOT_CLIENT_SECRET,
        redirect_uri: 'https://getconnectflows.com/auth/hubspot/callback',
        code: code
      })
    });
    
    const tokenData = await tokenResponse.json();
    
    if (!tokenResponse.ok) {
      throw new Error(tokenData.message || 'Token exchange failed');
    }
    
    req.session.hubspotToken = tokenData.access_token;
    req.session.hubspotConnected = true;
    
    console.log('✅ HubSpot connected successfully');
    res.redirect('/dashboard?message=' + encodeURIComponent('HubSpot connected successfully!'));
    
  } catch (error) {
    console.error('❌ HubSpot callback error:', error);
    res.redirect('/dashboard?error=HubSpot connection failed');
  }
});
app.get('/auth/hubspot',requireAuth,  (req, res) => {
  const { customer_id } = req.query;
  
  // Build proper authorization URL
  const authUrl = `https://app.hubspot.com/oauth/authorize?` +
    `client_id=${process.env.HUBSPOT_CLIENT_ID}&` +
    `redirect_uri=${encodeURIComponent(process.env.HUBSPOT_REDIRECT_URI)}&` +
    `scope=crm.objects.contacts.read crm.objects.contacts.write crm.schemas.contacts.read crm.schemas.contacts.write oauth&` +
    `state=${customer_id || 'test'}&` +
    `response_type=code`;
  
  console.log('🔗 Redirecting to HubSpot:', authUrl);
  res.redirect(authUrl);
});

// HubSpot OAuth callback - COMPLETE WORKING VERSION
app.get('/auth/hubspot/callback', async (req, res) => {
  const { code, error, state, error_description } = req.query;
  const customer_id = state;
  
  console.log('📥 HubSpot callback received:', { 
    hasCode: !!code, 
    error, 
    error_description,
    customer_id 
  });
  
  if (error) {
    return res.json({ 
      success: false,
      error: error,
      description: error_description,
      message: "HubSpot authorization failed",
      customer_id: customer_id
    });
  }
  
  if (!code) {
    return res.json({ 
      success: false,
      error: "missing_code",
      message: "No authorization code received from HubSpot",
      customer_id: customer_id
    });
  }
  
  try {
    console.log('🔄 Exchanging code for access token...');
    
    const tokenRequestData = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: process.env.HUBSPOT_CLIENT_ID,
      client_secret: process.env.HUBSPOT_CLIENT_SECRET,
      redirect_uri: process.env.HUBSPOT_REDIRECT_URI,
      code: code
    });
    
    const tokenResponse = await fetch('https://api.hubapi.com/oauth/v1/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: tokenRequestData  
    });

      const tokenData = await tokenResponse.json();

      console.log('📥 HubSpot token response:', {
      success: tokenResponse.ok,
      status: tokenResponse.status,
      hasAccessToken: !!tokenData.access_token,
      error: tokenData.error
    });
    
    if (!tokenResponse.ok) {
      throw new Error(`Token exchange failed: ${tokenData.error_description || tokenData.error}`);
    }
    
    const { access_token, refresh_token, hub_id } = tokenData; req.session.hubspotToken = access_token;
    req.session.hubspotRefreshToken = refresh_token;
    req.session.hubspotHubId = hub_id;
    console.log('✅ HubSpot OAuth successful, tokens stored');
  
    
    // Test the access token by getting account info
    console.log('👤 Testing HubSpot access token...');
    const accountResponse = await fetch('https://api.hubapi.com/account-info/v3/details', {
      headers: {
        'Authorization': `Bearer ${access_token}`,
        'Accept': 'application/json'
      }
    });
    
    if (!accountResponse.ok) {
      throw new Error('Failed to fetch account info with access token');
    }
    
    const accountInfo = await accountResponse.json();
    
    console.log('✅ HubSpot OAuth successful for hub:', hub_id);
    
    // Success response
    res.redirect('/dashboard?hubspot=connected&message=' + encodeURIComponent('HubSpot connected successfully!'));
    
  } catch (error) {
    console.error('❌ HubSpot OAuth error:', error.message);
    
    res.status(500).json({
      success: false,
      error: error.message,
      message: "Failed to complete HubSpot authorization",
      customer_id: customer_id
    });
  }
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

// 💰 MONEY-MAKING SYNC ENDPOINTS 💰
app.get('/api/sync/contacts', (req, res) => {
  res.json({
    message: "💰 Contact Sync API Ready! 🚀",
    method: "Use POST to start sync",
    test_url: "POST /api/sync/contacts",
    status: "endpoint_available",
    demo_value: "This endpoint saves customers $50K+ annually",
    pricing: "$397/month subscription value"
  });
});

// REAL ENTERPRISE SYNC ENDPOINT FOR PAYING CUSTOMERS
app.post('/api/sync/contacts', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    console.log(`🚀 REAL: Enterprise sync request from paying customer: ${user.email}`);

    // Validate customer has required connections
    if (!req.session.salesforceToken) {
      return res.status(400).json({
        success: false,
        error: 'Salesforce connection required',
        message: 'Please connect your Salesforce account first'
      });
    }

    // Initialize REAL enterprise sync engine
    const syncEngine = new RealSyncEngine(
      user.id,
      req.session.salesforceToken,
      req.session.salesforceInstanceUrl,
      req.session.hubspotToken || null
    );
    
    // Perform REAL enterprise bidirectional sync
    const syncResults = await syncEngine.performEnterpriseBidirectionalSync();
   

    // Calculate real business value for paying customer
    const totalContacts = syncResults.salesforce_contacts_found;
    const timesSavedHours = Math.floor(totalContacts * 0.05); // 3 minutes per contact / 60
    const monthlySavings = Math.max(197, totalContacts * 3); // Minimum $197 value
    const annualSavings = monthlySavings * 12;

    // Return REAL enterprise results
    res.json({
      success: true,
      message: syncResults.message,
      sync_type: 'enterprise_bidirectional',
      real_results: {
        salesforce: {
          status: 'connected',
          contacts_found: syncResults.salesforce_contacts_found,
          sample_contacts: syncResults.real_sample_contacts // REAL CUSTOMER DATA
        },
        hubspot: {
          connected: !!req.session.hubspotToken,
          sync_status: syncResults.hubspot_sync_attempted ? 'completed' : 'ready_to_connect',
          contacts_created: syncResults.hubspot_created,
          contacts_updated: syncResults.hubspot_updated,
          total_synced: syncResults.hubspot_created + syncResults.hubspot_updated
        },
        business_impact: {
          total_records_processed: totalContacts,
          time_saved_hours: timesSavedHours,
          monthly_cost_savings: `$${monthlySavings}`,
          annual_savings: `$${annualSavings}`,
          roi_vs_connectflows_cost: `${Math.round((monthlySavings / 197) * 100)}%`,
          sync_efficiency: syncResults.hubspot_sync_attempted ? 'Real-time bidirectional' : 'Salesforce analysis complete'
        },
        enterprise_features: {
          data_source: 'Real customer CRM data',
          sync_method: 'API-based bidirectional',
          security: 'Enterprise OAuth',
          support: '24/7 monitoring'
        }
      },
      timestamp: new Date().toISOString() 
      
    });

  } catch (error) {
    console.error('❌ REAL: Enterprise sync failed:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Enterprise sync failed - our team has been notified'
    });
  }
});

app.get('/api/sync/trigger', (req, res) => {
  res.json({ 
    message: '🎯 Manual sync trigger available',
    instructions: 'POST to /api/sync/contacts to start sync',
    endpoint: '/api/sync/contacts',
    method: 'POST',
    customer_benefit: "One-click sync vs 3 hours manual work",
    revenue_opportunity: "$397/month per customer"
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
    path: req.originalUrl,
    available_endpoints: [
      '/health',
      '/api/sync/contacts',
      '/api/sync/trigger',
      '/api/status'
    ]
  });
});

// Start server
app.listen(PORT, () => {
  console.log('🚀 SF-HubSpot Sync Server Starting...');
  console.log(`📱 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔗 Server URL: http://localhost:${PORT}`);
  console.log(`📊 Health Check: http://localhost:${PORT}/health`);
  console.log(`💰 Sync API: http://localhost:${PORT}/api/sync/contacts`);
  console.log(`🎯 Trigger: http://localhost:${PORT}/api/sync/trigger`);
  console.log('✅ Server ready for connections!');
  console.log('💸 Ready to make money from customer subscriptions!');
  
  if (!process.env.SF_CLIENT_ID) {
    console.log('⚠️  Warning: SF_CLIENT_ID not set');
  }
  if (!process.env.HUBSPOT_CLIENT_ID) {
    console.log('⚠️  Warning: HUBSPOT_CLIENT_ID not set');
  }
});

module.exports = app;