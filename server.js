import express from 'express';
import cors from 'cors';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode-terminal';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';

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
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    }
});

// Event: Generate and display QR code in terminal
client.on('qr', (qr) => {
    console.log('Scan the QR code below to link your WhatsApp account:');
    qrcode.generate(qr, { small: true });
});

// Event: Client is ready
client.on('ready', () => {
    console.log('WhatsApp Gateway is ready and connected!');
});

// Event: Authentication successful
client.on('authenticated', () => {
    console.log('WhatsApp Authentication successful.');
});

// Event: Authentication failed
client.on('auth_failure', msg => {
    console.error('WhatsApp Authentication failed:', msg);
});

// Event: Client disconnected
client.on('disconnected', (reason) => {
    console.log('WhatsApp Client was logged out or disconnected:', reason);
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
