import express from 'express';
import cors from 'cors';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode-terminal';

const app = express();
const port = 3001;

// Middleware
app.use(cors());
app.use(express.json());

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
app.post('/send-otp', async (req, res) => {
    try {
        const { phone, message } = req.body;

        if (!phone || !message) {
            return res.status(400).json({ error: 'Phone number and message are required' });
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
