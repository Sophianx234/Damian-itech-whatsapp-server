import express from 'express';
import cors from 'cors';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import QRCode from 'qrcode'; // Replaced qrcode-terminal with native qrcode
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';

// Global state to hold the QR code for the /setup-qr route
let currentQR = "Waiting for QR code generation...";
// Global state to track the WhatsApp client status
let clientStatus = 'INITIALIZING';

// Load environment variables from .env file
dotenv.config();

const app = express();
const port = 3001;

// Middleware
app.use(cors());
app.use(express.json());

// --- Keep-Alive Endpoint ---
// This endpoint is strictly used to prevent Render container suspension due to inactivity.
// It bypasses all rate limiting and auth middlewares.
app.get('/keep-alive', (req, res) => {
    res.status(200).json({
        status: 'ok',
        message: 'awake',
        timestamp: new Date().toISOString()
    });
});

// --- QR Setup Endpoint ---
// Public endpoint to scan the WhatsApp QR code visually
app.get('/setup-qr', (req, res) => {
    if (currentQR.startsWith('data:image')) {
        return res.send(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>WhatsApp Setup</title>
                <style>
                    body { background-color: #1a1a1a; color: white; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; font-family: sans-serif; }
                    img { border: 10px solid white; border-radius: 8px; margin-top: 20px; }
                </style>
            </head>
            <body>
                <h1>Scan to Link WhatsApp</h1>
                <img src="${currentQR}" alt="WhatsApp QR Code" />
                <p>Refresh the page if it expires.</p>
            </body>
            </html>
        `);
    } else {
        return res.send(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>WhatsApp Setup</title>
                <style>
                    body { background-color: #1a1a1a; color: white; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; font-family: sans-serif; text-align: center; }
                </style>
            </head>
            <body>
                <h1>${currentQR}</h1>
            </body>
            </html>
        `);
    }
});

// --- Status Endpoint ---
// Public health-check endpoint to monitor the WhatsApp client state
app.get('/status', (req, res) => {
    res.json({
        status: clientStatus,
        timestamp: new Date().toISOString()
    });
});

// --- Security Middleware ---
// Rate Limiter: Max 5 OTP requests per minute per IP
const otpLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 5, // Limit each IP to 5 requests per `window` (here, per minute)
    keyGenerator: (req) => {
        // Use the forwarded IP from Next.js if available, otherwise use req.ip
        const forwarded = req.headers['x-forwarded-for'];
        return (forwarded ? forwarded.split(',')[0].trim() : req.ip);
    },
    message: { error: 'Too many requests from this IP, please try again after a minute' },
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

// API Key checker
const requireApiKey = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    
    if (!apiKey || apiKey !== process.env.API_SECRET_KEY) {
        return res.status(401).json({ error: 'Unauthorized: Invalid or missing API key' });
    }
    next();
};

// Initialize WhatsApp Client with LocalAuth to save session
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process', // Critical to stay under Render's RAM limits
            '--disable-gpu'
        ]
    }
});

// Event: Generate and capture QR code as Base64 Image
client.on('qr', async (qr) => {
    clientStatus = 'WAITING_FOR_QR';
    console.log(`[Status: ${clientStatus}] QR Code generated. Go to /setup-qr to scan it.`);
    try {
        currentQR = await QRCode.toDataURL(qr);
    } catch (err) {
        console.error('Failed to generate QR code image:', err);
        currentQR = "Error generating QR code.";
    }
});

// Event: Client is ready
client.on('ready', () => {
    clientStatus = 'CONNECTED_AND_READY';
    console.log(`[Status: ${clientStatus}] WhatsApp Gateway is ready and connected!`);
    currentQR = "Client is already connected. No QR needed.";
});

// Event: Authentication successful
client.on('authenticated', () => {
    clientStatus = 'AUTHENTICATED';
    console.log(`[Status: ${clientStatus}] WhatsApp Authentication successful.`);
});

// Event: Authentication failed
client.on('auth_failure', msg => {
    clientStatus = 'AUTH_FAILED';
    console.error(`[Status: ${clientStatus}] WhatsApp Authentication failed:`, msg);
});

// Event: Client disconnected
client.on('disconnected', (reason) => {
    clientStatus = 'DISCONNECTED';
    console.log(`[Status: ${clientStatus}] WhatsApp Client was logged out or disconnected:`, reason);
});

// Initialize client
client.initialize();

// Route to send OTP via WhatsApp
// We apply the rate limiter and the API key check specifically to this route
app.post('/send-otp', otpLimiter, requireApiKey, async (req, res) => {
    try {
        const { phone, message } = req.body;

        if (!phone || !message) {
            return res.status(400).json({ error: 'Phone number and message are required' });
        }

        // Basic phone number validation (digits and optional leading +)
        const cleanPhone = phone.replace('@c.us', '');
        const phoneRegex = /^\+?[0-9]{10,15}$/;
        if (!phoneRegex.test(cleanPhone)) {
            return res.status(400).json({ error: 'Invalid phone number format' });
        }

        // phone must include @c.us for whatsapp-web.js
        const formattedPhone = phone.includes('@c.us') ? phone : `${phone}@c.us`;

        // Check if the number is registered on WhatsApp
        const isRegistered = await client.isRegisteredUser(formattedPhone);
        if (!isRegistered) {
            return res.status(404).json({ error: 'This phone number is not registered on WhatsApp' });
        }

        // Send the message with link preview enabled
        await client.sendMessage(formattedPhone, message, { linkPreview: true });
        
        console.log(`Successfully sent message to ${formattedPhone}`);
        return res.status(200).json({ success: true, message: 'Message sent successfully' });
    } catch (error) {
        console.error('Error sending WhatsApp message:', error);
        return res.status(500).json({ error: 'Failed to send WhatsApp message' });
    }
});

// Start Express server
app.listen(port, () => {
    console.log(`WhatsApp Express Microservice running on http://localhost:${port}`);
});
