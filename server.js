require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize services
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Google OAuth2 setup
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// Health check
app.get('/', (req, res) => {
  res.send('🤖 WhatsApp Booking Bot is running with Twilio & Google Calendar!');
});

// ============================================
// TWILIO WEBHOOK - Main message handler
// ============================================
app.post('/webhook', async (req, res) => {
  try {
    console.log('📥 Received webhook from Twilio:', JSON.stringify(req.body, null, 2));
    console.log('📋 All body keys:', Object.keys(req.body));
    console.log('📝 Body value:', req.body.Body);
    console.log('📝 body value:', req.body.body);

    // Quick 200 response to Twilio
    res.sendStatus(200);

    const messageBody = req.body.Body || req.body.body;
    const from = req.body.From; // Format: whatsapp:+972501234567
    const to = req.body.To; // Format: whatsapp:+14155238886
    
    console.log('🔍 Extracted - Body:', messageBody, 'From:', from, 'To:', to);
    
    if (!messageBody) {
      console.log('❌ No message body found in:', Object.keys(req.body));
      return;
    }

    // Extract phone numbers (remove whatsapp: prefix)
    const customerPhone = from.replace('whatsapp:', '');
    const businessPhone = to.replace('whatsapp:', '');

    console.log(`💬 Message from ${customerPhone}: ${messageBody}`);

    // Find business by WhatsApp number
    const { data: business, error: businessError } = await supabase
      .from('businesses')
      .select('*')
      .eq('whatsapp_number', businessPhone)
      .single();

    if (businessError || !business) {
      console.log('❌ Business not found for phone:', businessPhone);
      await sendWhatsAppMessage(customerPhone, 'מצטער, המערכת נמצאת בהגדרה. אנא נסה שוב מאוחר יותר.');
      return;
    }

    console.log(`✅ Found business: ${business.name}`);

    // Process with Gemini AI
    const aiResponse = await processWithGemini(messageBody, customerPhone, business);

    // Send response
    await sendWhatsAppMessage(customerPhone, aiResponse);

    // Check if appointment was confirmed
    if (aiResponse.includes('נקבע') || aiResponse.includes('אושר')) {
      console.log('📅 Appointment confirmed - attempting to add to calendar');
      
      if (business.google_calendar_token) {
        try {
          await addToGoogleCalendar(business, customerPhone, aiResponse);
        } catch (calError) {
          console.error('Calendar error:', calError);
        }
      }
    }

  } catch (error) {
    console.error('❌ Error in webhook:', error);
  }
});

// ============================================
// GEMINI AI PROCESSING
// ============================================
async function processWithGemini(messageText, customerPhone, business) {
  try {
    // Get conversation history
    const { data: history } = await supabase
      .from('conversations')
      .select('*')
      .eq('customer_phone', customerPhone)
      .eq('business_id', business.id)
      .order('created_at', { ascending: true })
      .limit(10);

    // Build context
    let conversationContext = '';
    if (history && history.length > 0) {
      conversationContext = history.map(h => 
        `${h.role === 'user' ? 'לקוח' : 'עוזר'}: ${h.content}`
      ).join('\n');
    }

    // Get booked appointments
    const { data: appointments } = await supabase
      .from('appointments')
      .select('appointment_time, customer_name')
      .eq('business_id', business.id)
      .eq('status', 'confirmed')
      .gte('appointment_time', new Date().toISOString());

    const bookedSlots = (appointments || []).map(a => 
      new Date(a.appointment_time).toLocaleString('he-IL')
    ).join(', ');

    // System prompt
    const systemPrompt = `אתה עוזר אוטומטי חכם לקביעת תורים עבור ${business.name}.

פרטי העסק:
- שעות פעילות: ${business.working_hours || '09:00-18:00'}
- משך תור: ${business.appointment_duration || 30} דקות
- ימי עבודה: ${business.working_days || 'א-ה'}

תורים קיימים: ${bookedSlots || 'אין תורים תפוסים'}

התפקיד שלך:
1. לעזור ללקוחות לקבוע תור בצורה ידידותית
2. להציע שעות פנויות
3. כשהלקוח בוחר שעה - לאשר ולומר "התור נקבע!"
4. לענות בעברית פשוטה וברורה (2-3 משפטים)

${conversationContext ? `היסטוריה:\n${conversationContext}\n` : ''}

הודעה נוכחית: ${messageText}

תשובתך (קצרה ומדויקת):`;

    const result = await model.generateContent(systemPrompt);
    const response = await result.response;
    const aiMessage = response.text();

    // Save conversation
    await supabase.from('conversations').insert([
      { business_id: business.id, customer_phone: customerPhone, role: 'user', content: messageText },
      { business_id: business.id, customer_phone: customerPhone, role: 'assistant', content: aiMessage }
    ]);

    return aiMessage;

  } catch (error) {
    console.error('❌ Gemini error:', error);
    return 'מצטער, נתקלתי בבעיה. אנא נסה שוב.';
  }
}

// ============================================
// TWILIO - Send WhatsApp message
// ============================================
async function sendWhatsAppMessage(to, message) {
  try {
    // Ensure number has whatsapp: prefix
    const toNumber = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
    const fromNumber = process.env.TWILIO_WHATSAPP_NUMBER || 'whatsapp:+14155238886';
    
    console.log(`📤 Sending to: ${toNumber} from: ${fromNumber}`);
    
    const result = await twilioClient.messages.create({
      from: fromNumber,
      to: toNumber,
      body: message
    });

    console.log('✅ Message sent:', result.sid);
    return result;
  } catch (error) {
    console.error('❌ Twilio send error:', error);
    throw error;
  }
}

// ============================================
// GOOGLE CALENDAR - OAuth flow
// ============================================
app.get('/connect-calendar', (req, res) => {
  const businessId = req.query.business_id;
  
  if (!businessId) {
    return res.send('❌ Missing business_id parameter');
  }

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar'],
    state: businessId // Pass business ID through OAuth flow
  });

  res.redirect(authUrl);
});

app.get('/oauth2callback', async (req, res) => {
  const code = req.query.code;
  const businessId = req.query.state;

  if (!code) {
    return res.send('❌ Authorization failed');
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    
    // Save tokens to database
    await supabase
      .from('businesses')
      .update({ 
        google_calendar_token: JSON.stringify(tokens),
        calendar_connected: true
      })
      .eq('id', businessId);

    res.send(`
      <html>
        <body style="font-family: Arial; text-align: center; padding: 50px;">
          <h1>✅ היומן חובר בהצלחה!</h1>
          <p>מעכשיו כל התורים יתווספו אוטומטית ליומן Google שלך.</p>
          <p>אפשר לסגור את הדף הזה.</p>
        </body>
      </html>
    `);

  } catch (error) {
    console.error('OAuth error:', error);
    res.send('❌ שגיאה בחיבור יומן. אנא נסה שוב.');
  }
});

// ============================================
// GOOGLE CALENDAR - Add appointment
// ============================================
async function addToGoogleCalendar(business, customerPhone, appointmentDetails) {
  try {
    if (!business.google_calendar_token) {
      console.log('No calendar token for business');
      return;
    }

    const tokens = JSON.parse(business.google_calendar_token);
    oauth2Client.setCredentials(tokens);

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    // Parse appointment time from AI response (simplified - in production use better parsing)
    const now = new Date();
    const appointmentStart = new Date(now.getTime() + 24 * 60 * 60 * 1000); // Tomorrow as example
    const appointmentEnd = new Date(appointmentStart.getTime() + (business.appointment_duration || 30) * 60 * 1000);

    const event = {
      summary: `תור - ${customerPhone}`,
      description: `לקוח: ${customerPhone}\n${appointmentDetails}`,
      start: {
        dateTime: appointmentStart.toISOString(),
        timeZone: 'Asia/Jerusalem',
      },
      end: {
        dateTime: appointmentEnd.toISOString(),
        timeZone: 'Asia/Jerusalem',
      },
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: 60 },
        ],
      },
    };

    const response = await calendar.events.insert({
      calendarId: 'primary',
      resource: event,
    });

    console.log('✅ Calendar event created:', response.data.htmlLink);
    
    // Save appointment to database
    await supabase.from('appointments').insert({
      business_id: business.id,
      customer_phone: customerPhone,
      appointment_time: appointmentStart.toISOString(),
      duration: business.appointment_duration || 30,
      status: 'confirmed',
      google_event_id: response.data.id
    });

    return response.data;

  } catch (error) {
    console.error('❌ Calendar add error:', error);
    throw error;
  }
}

// ============================================
// START SERVER
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 WhatsApp Bot ready with Twilio!`);
  console.log(`📅 Google Calendar integration enabled!`);
});
