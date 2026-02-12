require('dotenv').config();
const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// Initialize Anthropic (Claude)
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Health check endpoint
app.get('/', (req, res) => {
  res.send('WhatsApp Booking Bot is running! 🤖');
});

// Webhook verification (for 360dialog setup)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log('Webhook verified successfully!');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Main webhook endpoint - receives messages from WhatsApp
app.post('/webhook', async (req, res) => {
  try {
    console.log('Received webhook:', JSON.stringify(req.body, null, 2));

    // Quick response to 360dialog
    res.sendStatus(200);

    // Extract message data
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;

    if (!messages || messages.length === 0) {
      console.log('No messages in webhook');
      return;
    }

    const message = messages[0];
    const from = message.from; // Customer's phone number
    const messageText = message.text?.body;
    const messageId = message.id;

    if (!messageText) {
      console.log('No text in message');
      return;
    }

    console.log(`Message from ${from}: ${messageText}`);

    // Get business info from the phone number that received the message
    const businessPhone = value?.metadata?.phone_number_id;
    const { data: business, error: businessError } = await supabase
      .from('businesses')
      .select('*')
      .eq('whatsapp_phone_id', businessPhone)
      .single();

    if (businessError || !business) {
      console.log('Business not found for phone:', businessPhone);
      await sendWhatsAppMessage(from, 'מצטער, המערכת נמצאת בהגדרה. אנא נסה שוב מאוחר יותר.');
      return;
    }

    // Process message with Claude AI
    const aiResponse = await processWithClaude(messageText, from, business);

    // Send response back to customer
    await sendWhatsAppMessage(from, aiResponse);

  } catch (error) {
    console.error('Error processing webhook:', error);
  }
});

// Process message with Claude AI
async function processWithClaude(messageText, customerPhone, business) {
  try {
    // Get conversation history
    const { data: history } = await supabase
      .from('conversations')
      .select('*')
      .eq('customer_phone', customerPhone)
      .eq('business_id', business.id)
      .order('created_at', { ascending: true })
      .limit(10);

    // Build conversation context
    const conversationHistory = (history || []).map(h => ({
      role: h.role,
      content: h.content
    }));

    // Add current message
    conversationHistory.push({
      role: 'user',
      content: messageText
    });

    // Get available time slots
    const { data: appointments } = await supabase
      .from('appointments')
      .select('appointment_time')
      .eq('business_id', business.id)
      .eq('status', 'confirmed')
      .gte('appointment_time', new Date().toISOString());

    const bookedSlots = (appointments || []).map(a => a.appointment_time);

    // System prompt for Claude
    const systemPrompt = `אתה עוזר אוטומטי לקביעת תורים עבור ${business.name}.

פרטי העסק:
- שעות פעילות: ${business.working_hours || '09:00-18:00'}
- משך תור: ${business.appointment_duration || 30} דקות
- ימי עבודה: ${business.working_days || 'א-ה'}

תפקידך:
1. לעזור ללקוחות לקבוע תור
2. להציע שעות פנויות
3. לאשר את פרטי התור
4. לענות בצורה ידידותית ומקצועית

תורים תפוסים היום: ${bookedSlots.join(', ') || 'אין'}

כשהלקוח מבקש תור:
1. שאל באיזה יום ושעה
2. בדוק זמינות
3. אשר את הפרטים
4. תן הודעת אישור

ענה בעברית, בצורה קצרה וברורה.`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: systemPrompt,
      messages: conversationHistory
    });

    const aiMessage = response.content[0].text;

    // Save conversation
    await supabase.from('conversations').insert([
      {
        business_id: business.id,
        customer_phone: customerPhone,
        role: 'user',
        content: messageText
      },
      {
        business_id: business.id,
        customer_phone: customerPhone,
        role: 'assistant',
        content: aiMessage
      }
    ]);

    // Check if appointment was made (simple detection)
    if (aiMessage.includes('נקבע') || aiMessage.includes('אושר')) {
      // Here you would extract the time and save the appointment
      // This is a simplified version - in production you'd use Claude's tool calling
      console.log('Appointment detected - would save to database');
    }

    return aiMessage;

  } catch (error) {
    console.error('Error with Claude:', error);
    return 'מצטער, נתקלתי בבעיה. אנא נסה שוב.';
  }
}

// Send WhatsApp message via 360dialog
async function sendWhatsAppMessage(to, message) {
  try {
    const url = `https://waba.360dialog.io/v1/messages`;
    
    const response = await axios.post(
      url,
      {
        recipient_type: 'individual',
        to: to,
        type: 'text',
        text: {
          body: message
        }
      },
      {
        headers: {
          'D360-API-KEY': process.env.DIALOG_360_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('Message sent successfully:', response.data);
    return response.data;

  } catch (error) {
    console.error('Error sending WhatsApp message:', error.response?.data || error.message);
    throw error;
  }
}

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 WhatsApp Booking Bot is ready!`);
});
