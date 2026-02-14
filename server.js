require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize services
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Google OAuth2 setup
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// Health check
app.get('/', (req, res) => {
  res.send('🤖 WhatsApp Booking Bot is running with OpenAI & Full Calendar Integration!');
});

// ============================================
// CALENDAR SYNC JOB - Runs every 5 minutes
// ============================================
async function syncCalendarForBusiness(business) {
  if (!business.google_calendar_token || !business.calendar_connected) {
    return;
  }

  try {
    const tokens = JSON.parse(business.google_calendar_token);
    oauth2Client.setCredentials(tokens);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    // Get events from calendar
    const now = new Date();
    const endOfDay = new Date(now);
    endOfDay.setDate(endOfDay.getDate() + 30); // Next 30 days

    const response = await calendar.events.list({
      calendarId: business.calendar_id || 'primary',
      timeMin: now.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = response.data.items || [];

    // Sync to database
    for (const event of events) {
      if (!event.start || !event.start.dateTime) continue;

      const eventId = event.id;
      const startTime = new Date(event.start.dateTime);

      // Check if appointment exists
      const { data: existing } = await supabase
        .from('appointments')
        .select('*')
        .eq('google_event_id', eventId)
        .single();

      if (!existing) {
        // Create new appointment from calendar event
        await supabase.from('appointments').insert({
          business_id: business.id,
          customer_phone: 'unknown',
          customer_name: event.summary || 'תור מיומן',
          appointment_time: startTime.toISOString(),
          duration: business.appointment_duration || 30,
          status: 'confirmed',
          google_event_id: eventId,
          notes: 'נוצר ידנית ביומן Google'
        });
      }
    }

    // Update last sync time
    await supabase
      .from('businesses')
      .update({ last_sync_time: new Date().toISOString() })
      .eq('id', business.id);

    console.log(`✅ Synced calendar for ${business.name}`);

  } catch (error) {
    console.error(`❌ Calendar sync error for ${business.name}:`, error.message);
  }
}

async function runCalendarSync() {
  try {
    const { data: businesses } = await supabase
      .from('businesses')
      .select('*')
      .eq('calendar_connected', true);

    if (businesses && businesses.length > 0) {
      console.log(`🔄 Syncing ${businesses.length} business calendars...`);
      for (const business of businesses) {
        await syncCalendarForBusiness(business);
      }
    }
  } catch (error) {
    console.error('❌ Calendar sync job error:', error);
  }
}

// Run sync every 5 minutes
setInterval(runCalendarSync, 5 * 60 * 1000);
// Run on startup
setTimeout(runCalendarSync, 10000);

// ============================================
// HELPER FUNCTIONS
// ============================================

// Check for conflicting appointments
async function hasConflict(businessId, requestedTime, duration) {
  const startTime = new Date(requestedTime);
  const endTime = new Date(startTime.getTime() + duration * 60000);

  const { data: conflicts } = await supabase
    .from('appointments')
    .select('*')
    .eq('business_id', businessId)
    .in('status', ['pending', 'confirmed'])
    .gte('appointment_time', startTime.toISOString())
    .lte('appointment_time', endTime.toISOString());

  return conflicts && conflicts.length > 0;
}

// Find alternative slots
async function findAlternativeSlots(business, requestedDate, count = 3) {
  const slots = [];
  const date = new Date(requestedDate);
  date.setHours(9, 0, 0, 0); // Start at 9 AM

  for (let i = 0; i < 50; i++) { // Check 50 slots
    const slotTime = new Date(date.getTime() + i * 30 * 60000); // 30-min intervals
    
    if (slotTime.getHours() >= 18) continue; // Skip after 6 PM

    const conflict = await hasConflict(business.id, slotTime, business.appointment_duration);
    
    if (!conflict) {
      slots.push(slotTime);
      if (slots.length >= count) break;
    }
  }

  return slots;
}

// Send WhatsApp notification to business owner
async function notifyBusinessOwner(business, appointment, customerPhone) {
  if (!business.owner_phone) return;

  const appointmentTime = new Date(appointment.appointment_time);
  const formattedTime = appointmentTime.toLocaleString('he-IL', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

  const message = `🔔 תור חדש ב${business.name}!\n\n` +
    `👤 לקוח: ${customerPhone}\n` +
    `📅 זמן: ${formattedTime}\n` +
    `⏱️ משך: ${appointment.duration} דקות\n\n` +
    `✅ התור נקבע אוטומטית ונוסף ליומן Google שלך.`;

  try {
    await sendWhatsAppMessage(business.owner_phone, message);
    console.log(`✅ Notified owner: ${business.owner_phone}`);
  } catch (error) {
    console.error(`❌ Failed to notify owner:`, error.message);
  }
}

// ============================================
// TWILIO WEBHOOK
// ============================================
app.post('/webhook', async (req, res) => {
  try {
    console.log('📥 Received webhook from Twilio');
    res.sendStatus(200);

    const messageBody = req.body.Body;
    const from = req.body.From; 
    const to = req.body.To;
    
    if (!messageBody) return;

    const customerPhone = from.replace('whatsapp:', '');
    const businessPhone = to.replace('whatsapp:', '');

    console.log(`💬 Message from ${customerPhone}: ${messageBody}`);
    console.log(`🔍 Looking for business with number: ${businessPhone}`);

    // Find business
    const { data: business, error: businessError } = await supabase
      .from('businesses')
      .select('*')
      .eq('whatsapp_number', businessPhone)
      .single();

    console.log(`📊 Business lookup result:`, business);
    console.log(`❌ Business lookup error:`, businessError);

    if (!business) {
      console.log(`❌ No business found for: ${businessPhone}`);
      await sendWhatsAppMessage(customerPhone, 'מצטער, המערכת נמצאת בהגדרה.');
      return;
    }

    console.log(`✅ Found business: ${business.name}`);

    // Process with OpenAI
    const aiResponse = await processWithOpenAI(messageBody, customerPhone, business);

    // Send response
    await sendWhatsAppMessage(customerPhone, aiResponse);

  } catch (error) {
    console.error('❌ Error in webhook:', error);
  }
});

// ============================================
// OPENAI PROCESSING WITH APPOINTMENT LOGIC
// ============================================
async function processWithOpenAI(messageText, customerPhone, business) {
  try {
    // Get conversation history
    const { data: history } = await supabase
      .from('conversations')
      .select('*')
      .eq('customer_phone', customerPhone)
      .eq('business_id', business.id)
      .order('created_at', { ascending: true })
      .limit(10);

    // Check for pending appointments
    const { data: pendingAppointment } = await supabase
      .from('appointments')
      .select('*')
      .eq('business_id', business.id)
      .eq('customer_phone', customerPhone)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    // Get booked slots
    const { data: bookedSlots } = await supabase
      .from('appointments')
      .select('appointment_time')
      .eq('business_id', business.id)
      .in('status', ['pending', 'confirmed'])
      .gte('appointment_time', new Date().toISOString())
      .order('appointment_time')
      .limit(20);

    const bookedTimes = (bookedSlots || []).map(s => 
      new Date(s.appointment_time).toLocaleString('he-IL', {
        weekday: 'short',
        day: 'numeric',
        month: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
    );

    // Build conversation
    const messages = [
      {
        role: 'system',
        content: `אתה עוזר אוטומטי חכם לקביעת תורים עבור ${business.name}.

פרטי העסק:
- שעות פעילות: ${business.working_hours || '09:00-18:00'}
- משך תור: ${business.appointment_duration || 30} דקות
- ימי עבודה: ${business.working_days || 'א-ה'}

תורים תפוסים: ${bookedTimes.length > 0 ? bookedTimes.join(', ') : 'אין'}

${pendingAppointment ? `\n⚠️ יש תור ממתין לאישור:\nזמן: ${new Date(pendingAppointment.appointment_time).toLocaleString('he-IL')}\n` : ''}

התפקיד שלך:
1. לעזור ללקוח לקבוע תור בצורה ידידותית
2. כשהלקוח מציע זמן - תבדוק אם פנוי
3. אם תפוס - תציע 3 אלטרנטיבות קרובות
4. לפני קביעה סופית - תשאל: "אני מאשר את התור ל[זמן]?"
5. רק אחרי אישור - תכתוב "CONFIRM:[זמן בפורמט ISO]"

דוגמה לפלט:
"מצוין! התור פנוי. אני מאשר לך תור ליום שלישי 18.2 בשעה 14:00?"

אחרי אישור של הלקוח:
"CONFIRM:2026-02-18T14:00:00"

חשוב:
- תמיד תענה בעברית בלבד
- תהיה קצר וברור (2-3 משפטים)
- רק CONFIRM כשהלקוח מאשר במפורש`
      }
    ];

    // Add history
    if (history && history.length > 0) {
      history.forEach(h => {
        messages.push({
          role: h.role === 'user' ? 'user' : 'assistant',
          content: h.content
        });
      });
    }

    // Add current message
    messages.push({
      role: 'user',
      content: messageText
    });

    // Call OpenAI
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: messages,
      max_tokens: 400,
      temperature: 0.7,
    });

    let aiMessage = completion.choices[0].message.content;

    // Save conversation
    await supabase.from('conversations').insert([
      { business_id: business.id, customer_phone: customerPhone, role: 'user', content: messageText },
      { business_id: business.id, customer_phone: customerPhone, role: 'assistant', content: aiMessage }
    ]);

    // Check for confirmation
    if (aiMessage.includes('CONFIRM:')) {
      const match = aiMessage.match(/CONFIRM:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
      if (match) {
        const appointmentTime = match[1];
        await createAppointment(business, customerPhone, appointmentTime);
        aiMessage = aiMessage.replace(/CONFIRM:.*/, '✅ מעולה! התור נקבע בהצלחה. תקבל תזכורת לפני המועד.');
      }
    }

    return aiMessage;

  } catch (error) {
    console.error('❌ OpenAI error:', error);
    return 'מצטער, נתקלתי בבעיה טכנית. אנא נסה שוב או צור קשר עם בעל העסק.';
  }
}

// ============================================
// CREATE APPOINTMENT
// ============================================
async function createAppointment(business, customerPhone, appointmentTime) {
  try {
    const startTime = new Date(appointmentTime);
    const duration = business.appointment_duration || 30;

    // Check for conflicts
    const conflict = await hasConflict(business.id, startTime, duration);
    if (conflict) {
      console.log('⚠️ Conflict detected, appointment not created');
      return null;
    }

    // Create in database
    const { data: appointment } = await supabase
      .from('appointments')
      .insert({
        business_id: business.id,
        customer_phone: customerPhone,
        appointment_time: startTime.toISOString(),
        duration: duration,
        status: 'confirmed',
        confirmed_at: new Date().toISOString()
      })
      .select()
      .single();

    console.log(`✅ Appointment created: ${appointment.id}`);

    // Add to Google Calendar
    if (business.calendar_connected) {
      await addToGoogleCalendar(business, appointment, customerPhone);
    }

    // Notify business owner
    await notifyBusinessOwner(business, appointment, customerPhone);

    return appointment;

  } catch (error) {
    console.error('❌ Create appointment error:', error);
    return null;
  }
}

// ============================================
// GOOGLE CALENDAR
// ============================================
async function addToGoogleCalendar(business, appointment, customerPhone) {
  try {
    if (!business.google_calendar_token) return;

    const tokens = JSON.parse(business.google_calendar_token);
    oauth2Client.setCredentials(tokens);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const startTime = new Date(appointment.appointment_time);
    const endTime = new Date(startTime.getTime() + appointment.duration * 60000);

    const event = {
      summary: `תור - ${customerPhone}`,
      description: `לקוח: ${customerPhone}\nנקבע דרך WhatsApp Bot`,
      start: { dateTime: startTime.toISOString(), timeZone: 'Asia/Jerusalem' },
      end: { dateTime: endTime.toISOString(), timeZone: 'Asia/Jerusalem' },
      reminders: {
        useDefault: false,
        overrides: [{ method: 'popup', minutes: 60 }],
      },
    };

    const response = await calendar.events.insert({
      calendarId: business.calendar_id || 'primary',
      resource: event,
    });

    // Save event ID
    await supabase
      .from('appointments')
      .update({ google_event_id: response.data.id })
      .eq('id', appointment.id);

    console.log(`✅ Added to Google Calendar: ${response.data.id}`);

  } catch (error) {
    console.error('❌ Calendar add error:', error);
  }
}

// OAuth flow
app.get('/connect-calendar', (req, res) => {
  const businessId = req.query.business_id;
  if (!businessId) return res.send('❌ Missing business_id');

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar'],
    state: businessId
  });

  res.redirect(authUrl);
});

app.get('/oauth2callback', async (req, res) => {
  const code = req.query.code;
  const businessId = req.query.state;

  if (!code) return res.send('❌ Authorization failed');

  try {
    const { tokens } = await oauth2Client.getToken(code);
    
    await supabase
      .from('businesses')
      .update({ 
        google_calendar_token: JSON.stringify(tokens),
        calendar_connected: true
      })
      .eq('id', businessId);

    res.send(`<html><body style="font-family: Arial; text-align: center; padding: 50px;">
      <h1>✅ היומן חובר בהצלחה!</h1>
      <p>מעכשיו כל התורים יתווספו אוטומטית ליומן Google שלך.</p>
      <p>המערכת תסתנכרן כל 5 דקות.</p>
      <p>אפשר לסגור את הדף הזה.</p>
    </body></html>`);

  } catch (error) {
    console.error('OAuth error:', error);
    res.send('❌ שגיאה בחיבור יומן');
  }
});

// ============================================
// TWILIO - Send Message
// ============================================
async function sendWhatsAppMessage(to, message) {
  try {
    const toNumber = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
    const fromNumber = process.env.TWILIO_WHATSAPP_NUMBER || 'whatsapp:+14155238886';
    
    const result = await twilioClient.messages.create({
      from: fromNumber,
      to: toNumber,
      body: message
    });

    console.log(`✅ Message sent: ${result.sid}`);
    return result;
  } catch (error) {
    console.error('❌ Twilio send error:', error);
    throw error;
  }
}

// ============================================
// START SERVER
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 WhatsApp Bot with full booking system!`);
  console.log(`🤖 OpenAI ChatGPT enabled`);
  console.log(`📅 Google Calendar sync every 5 minutes`);
  console.log(`🔔 Owner notifications enabled`);
});
