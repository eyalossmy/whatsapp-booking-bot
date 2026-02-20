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
  res.send('🤖 WhatsApp Booking Bot - Full System Ready!');
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

    const now = new Date();
    const endOfDay = new Date(now);
    endOfDay.setDate(endOfDay.getDate() + 30);

    const response = await calendar.events.list({
      calendarId: business.calendar_id || 'primary',
      timeMin: now.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = response.data.items || [];

    for (const event of events) {
      if (!event.start || !event.start.dateTime) continue;

      const eventId = event.id;
      const startTime = new Date(event.start.dateTime);

      const { data: existing } = await supabase
        .from('appointments')
        .select('*')
        .eq('google_event_id', eventId)
        .single();

      if (!existing) {
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

setInterval(runCalendarSync, 5 * 60 * 1000);
setTimeout(runCalendarSync, 10000);

// ============================================
// HELPER FUNCTIONS
// ============================================

// ✅ תיקון הבאג הראשי - בדיקת חפיפה נכונה
async function hasConflict(businessId, requestedTime, duration) {
  const startTime = new Date(requestedTime);
  const endTime = new Date(startTime.getTime() + duration * 60000);

  // מושך את כל התורים הפעילים של העסק
  const { data: appointments } = await supabase
    .from('appointments')
    .select('appointment_time, duration')
    .eq('business_id', businessId)
    .in('status', ['pending', 'confirmed']);

  if (!appointments || appointments.length === 0) return false;

  // בודק חפיפה אמיתית: A מתנגש עם B אם הם חופפים בזמן
  for (const appt of appointments) {
    const apptStart = new Date(appt.appointment_time);
    const apptEnd = new Date(apptStart.getTime() + (appt.duration || 30) * 60000);

    // חפיפה קיימת אם אחד מתחיל לפני שהשני מסתיים
    const overlaps = startTime < apptEnd && endTime > apptStart;
    
    if (overlaps) {
      console.log(`⚠️ Conflict found: requested ${startTime.toISOString()} overlaps with ${apptStart.toISOString()}`);
      return true;
    }
  }

  return false;
}

async function findAlternativeSlots(business, requestedDate, count = 5) {
  const slots = [];
  const date = new Date(requestedDate);
  
  // Start from the requested date
  date.setHours(9, 0, 0, 0);
  
  // Try current day and next 7 days
  for (let day = 0; day < 7; day++) {
    const checkDate = new Date(date);
    checkDate.setDate(checkDate.getDate() + day);
    
    // Try every 30 minutes from 9:00 to 18:00
    for (let hour = 9; hour < 18; hour++) {
      for (let minute = 0; minute < 60; minute += (business.appointment_duration || 30)) {
        const slotTime = new Date(checkDate);
        slotTime.setHours(hour, minute, 0, 0);
        
        // Skip past times
        if (slotTime <= new Date()) continue;
        
        const conflict = await hasConflict(business.id, slotTime, business.appointment_duration || 30);
        
        if (!conflict) {
          slots.push(slotTime);
          if (slots.length >= count) return slots;
        }
      }
    }
  }

  return slots;
}

// Send WhatsApp notification to business owner
async function notifyBusinessOwner(business, appointment, customerPhone, action = 'new') {
  if (!business.owner_phone) return;

  const appointmentTime = new Date(appointment.appointment_time);
  
  const dayName = appointmentTime.toLocaleDateString('he-IL', { weekday: 'long' });
  const date = appointmentTime.toLocaleDateString('he-IL', { 
    day: 'numeric', 
    month: 'long', 
    year: 'numeric' 
  });
  const time = appointmentTime.toLocaleTimeString('he-IL', { 
    hour: '2-digit', 
    minute: '2-digit' 
  });

  const customerName = appointment.customer_name || customerPhone;

  let message = '';
  
  if (action === 'new') {
    message = `🔔 תור חדש ב${business.name}!\n\n` +
      `👤 לקוח: ${customerName}\n` +
      `📞 טלפון: ${customerPhone}\n` +
      `📅 ${dayName}, ${date}\n` +
      `🕐 שעה: ${time}\n` +
      `⏱️ משך: ${appointment.duration} דקות\n\n` +
      `✅ התור נקבע אוטומטית ונוסף ליומן Google שלך.`;
  } else if (action === 'cancelled') {
    message = `❌ תור בוטל ב${business.name}\n\n` +
      `👤 לקוח: ${customerName}\n` +
      `📞 טלפון: ${customerPhone}\n` +
      `📅 ${dayName}, ${date}\n` +
      `🕐 שעה: ${time}\n\n` +
      `התור הוסר מהיומן Google שלך.`;
  } else if (action === 'rescheduled') {
    message = `🔄 תור שונה ב${business.name}\n\n` +
      `👤 לקוח: ${customerName}\n` +
      `📞 טלפון: ${customerPhone}\n` +
      `📅 זמן חדש: ${dayName}, ${date}\n` +
      `🕐 שעה: ${time}\n\n` +
      `היומן Google עודכן.`;
  }

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

    const aiResponse = await processWithOpenAI(messageBody, customerPhone, business);
    await sendWhatsAppMessage(customerPhone, aiResponse);

  } catch (error) {
    console.error('❌ Error in webhook:', error);
  }
});

// ============================================
// OPENAI PROCESSING
// ============================================
async function processWithOpenAI(messageText, customerPhone, business) {
  try {
    const { data: history } = await supabase
      .from('conversations')
      .select('*')
      .eq('customer_phone', customerPhone)
      .eq('business_id', business.id)
      .order('created_at', { ascending: true })
      .limit(10);

    // Check for existing appointments
    const { data: existingAppointments } = await supabase
      .from('appointments')
      .select('*')
      .eq('business_id', business.id)
      .eq('customer_phone', customerPhone)
      .in('status', ['pending', 'confirmed'])
      .gte('appointment_time', new Date().toISOString())
      .order('appointment_time', { ascending: true });

    const { data: bookedSlots } = await supabase
      .from('appointments')
      .select('appointment_time, duration')
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

    // Get available slots for context
    const availableSlots = await findAlternativeSlots(business, new Date(), 8);
    const availableTimesText = availableSlots.map(s => 
      s.toLocaleString('he-IL', {
        weekday: 'short',
        day: 'numeric',
        month: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
    ).join(', ');

    // Current date info for AI
    const now = new Date();
    const today = now.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    
    // Next 7 days with dates
    const nextDays = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() + i);
      nextDays.push({
        day: d.toLocaleDateString('he-IL', { weekday: 'long' }),
        date: d.toISOString().split('T')[0],
        formatted: d.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' })
      });
    }
    const daysInfo = nextDays.map(d => `${d.day} = ${d.date} (${d.formatted})`).join('\n');

    let contextInfo = '';
    if (existingAppointments && existingAppointments.length > 0) {
      const appt = existingAppointments[0];
      const apptTime = new Date(appt.appointment_time);
      contextInfo = `\n\nללקוח יש תור קיים:\nתאריך: ${apptTime.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' })}\nשעה: ${apptTime.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}\nID: ${appt.id}`;
    }

    const messages = [
      {
        role: 'system',
        content: `אתה עוזר אוטומטי חכם לקביעת תורים עבור ${business.name}.

התאריך והזמן הנוכחי:
היום: ${today}
שעה: ${now.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}

ימים קרובים (לחישוב תאריכים):
${daysInfo}

פרטי העסק:
- שעות פעילות: ${business.working_hours || '09:00-18:00'}
- משך תור: ${business.appointment_duration || 30} דקות
- ימי עבודה: ${business.working_days || 'א-ה'}
${business.owner_phone ? `- לשאלות נוספות: ${business.owner_phone}` : ''}

תורים תפוסים: ${bookedTimes.length > 0 ? bookedTimes.join(', ') : 'אין תורים תפוסים'}

⚠️ זמנים פנויים (אלה הזמנים היחידים שאתה יכול להציע!):
${availableTimesText || 'אין זמנים פנויים בשבוע הקרוב'}

⚠️ חשוב: אל תציע זמנים שלא ברשימת הזמנים הפנויים למעלה!
${contextInfo}

⚠️ חוקי קביעת תור - חובה לעקוב אחריהם:

1. תמיד תשאל את שם הלקוח בהתחלה (אם לא יודע)

2. כשהלקוח מציע זמן שנמצא ברשימת הזמנים הפנויים → תשאל אישור עם תאריך מלא
   כשהלקוח מציע זמן שאינו ברשימה → תגיד "תפוס" ותציע מהזמנים הפנויים

3. ⚠️ זיכרון הצעות - חשוב מאוד:
   אם הצעת "יום שני 15:00 או שלישי 14:00" והלקוח ענה "15:00"
   → תבין שהוא מדבר על יום שני 15:00 ואל תשאל "איזה יום?"
   → פשוט תאשר: "מאשר לך יום שני 24.2 בשעה 15:00?"

4. לפני CONFIRM - חובה לכתוב:
   "מאשר לך תור ל[יום], [תאריך מלא] בשעה [שעה]?"

5. רק אחרי שהלקוח עונה "כן" / "אישור" / "בטח" → כתוב בשורה נפרדת:
   CONFIRM:YYYY-MM-DDTHH:mm:00|NAME:שם_הלקוח
   דוגמה: CONFIRM:2026-02-24T15:00:00|NAME:איל

⚠️ אסור לכתוב CONFIRM לפני אישור מפורש של הלקוח!
⚠️ ה-CONFIRM חייב להיות זמן מרשימת הזמנים הפנויים!

ביטול: CANCEL:[id]
שינוי: RESCHEDULE:[id]|NEW_TIME:[זמן]|NAME:[שם]

תענה בעברית בלבד, קצר וברור.`
      }
    ];

    if (history && history.length > 0) {
      history.forEach(h => {
        messages.push({
          role: h.role === 'user' ? 'user' : 'assistant',
          content: h.content
        });
      });
    }

    messages.push({
      role: 'user',
      content: messageText
    });

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

    // Handle CONFIRM
    if (aiMessage.includes('CONFIRM:')) {
      const match = aiMessage.match(/CONFIRM:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
      const nameMatch = aiMessage.match(/NAME:([^\n|]+)/);
      
      if (match) {
        const appointmentTime = match[1];
        const customerName = nameMatch ? nameMatch[1].trim() : null;

        console.log(`📅 Creating appointment: ${appointmentTime} for ${customerName}`);
        
        const appt = await createAppointment(business, customerPhone, appointmentTime, customerName);
        
        if (appt) {
          const apptDate = new Date(appointmentTime);
          const dayName = apptDate.toLocaleDateString('he-IL', { weekday: 'long' });
          const dateFormatted = apptDate.toLocaleDateString('he-IL', { day: 'numeric', month: 'long' });
          const timeFormatted = apptDate.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
          
          let confirmMsg = `✅ מעולה ${customerName ? customerName : ''}! התור נקבע בהצלחה.\n\n` +
            `📅 ${dayName}, ${dateFormatted}\n` +
            `🕐 שעה: ${timeFormatted}\n` +
            `⏱️ משך: ${business.appointment_duration || 30} דקות\n\n` +
            `📍 ${business.name}\n`;
          
          if (business.owner_phone) {
            confirmMsg += `📞 ${business.owner_phone}\n\n`;
          } else {
            confirmMsg += '\n';
          }
          
          confirmMsg += `תקבל תזכורת לפני המועד. נתראה! 👋`;
          
          aiMessage = confirmMsg;
        } else {
          aiMessage = '❌ מצטער, הזמן שנבחר כבר תפוס. אנא בחר זמן אחר.';
        }
      }
    }

    // Handle CANCEL
    if (aiMessage.includes('CANCEL:')) {
      const match = aiMessage.match(/CANCEL:([a-f0-9-]+)/);
      
      if (match) {
        const appointmentId = match[1];
        await cancelAppointment(business, appointmentId, customerPhone);
        aiMessage = aiMessage.replace(/CANCEL:.*/, '✅ התור בוטל בהצלחה.');
      }
    }

    // Handle RESCHEDULE
    if (aiMessage.includes('RESCHEDULE:')) {
      const match = aiMessage.match(/RESCHEDULE:([a-f0-9-]+)\|NEW_TIME:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
      const nameMatch = aiMessage.match(/NAME:([^\n|]+)/);
      
      if (match) {
        const appointmentId = match[1];
        const newTime = match[2];
        const customerName = nameMatch ? nameMatch[1].trim() : null;
        
        await rescheduleAppointment(business, appointmentId, newTime, customerPhone, customerName);
        aiMessage = aiMessage.replace(/RESCHEDULE:.*/, '✅ התור שונה בהצלחה!');
      }
    }

    return aiMessage;

  } catch (error) {
    console.error('❌ OpenAI error:', error);
    return 'מצטער, נתקלתי בבעיה טכנית. אנא נסה שוב או צור קשר עם בעל העסק.';
  }
}

// ============================================
// APPOINTMENT MANAGEMENT
// ============================================

async function createAppointment(business, customerPhone, appointmentTime, customerName = null) {
  try {
    const startTime = new Date(appointmentTime);
    const duration = business.appointment_duration || 30;

    // ✅ בדיקת קונפליקט אחרי תיקון
    const conflict = await hasConflict(business.id, startTime, duration);
    if (conflict) {
      console.log('⚠️ Conflict detected, appointment not created');
      return null;
    }

    const { data: appointment, error } = await supabase
      .from('appointments')
      .insert({
        business_id: business.id,
        customer_phone: customerPhone,
        customer_name: customerName,
        appointment_time: startTime.toISOString(),
        duration: duration,
        status: 'confirmed',
        confirmed_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) {
      console.error('❌ Supabase insert error:', error);
      return null;
    }

    console.log(`✅ Appointment created: ${appointment.id}`);

    if (business.calendar_connected) {
      await addToGoogleCalendar(business, appointment, customerPhone);
    }

    await notifyBusinessOwner(business, appointment, customerPhone, 'new');

    return appointment;

  } catch (error) {
    console.error('❌ Create appointment error:', error);
    return null;
  }
}

async function cancelAppointment(business, appointmentId, customerPhone) {
  try {
    const { data: appointment } = await supabase
      .from('appointments')
      .select('*')
      .eq('id', appointmentId)
      .eq('business_id', business.id)
      .single();

    if (!appointment) {
      console.log('❌ Appointment not found');
      return false;
    }

    if (appointment.google_event_id && business.calendar_connected) {
      await deleteFromGoogleCalendar(business, appointment.google_event_id);
    }

    await supabase
      .from('appointments')
      .update({ 
        status: 'cancelled',
        cancelled_at: new Date().toISOString()
      })
      .eq('id', appointmentId);

    console.log(`✅ Appointment cancelled: ${appointmentId}`);

    await notifyBusinessOwner(business, appointment, customerPhone, 'cancelled');

    return true;

  } catch (error) {
    console.error('❌ Cancel appointment error:', error);
    return false;
  }
}

async function rescheduleAppointment(business, appointmentId, newTime, customerPhone, customerName = null) {
  try {
    const { data: oldAppointment } = await supabase
      .from('appointments')
      .select('*')
      .eq('id', appointmentId)
      .eq('business_id', business.id)
      .single();

    if (!oldAppointment) {
      console.log('❌ Appointment not found');
      return false;
    }

    const startTime = new Date(newTime);
    const duration = business.appointment_duration || 30;

    const conflict = await hasConflict(business.id, startTime, duration);
    if (conflict) {
      console.log('⚠️ New time has conflict');
      return false;
    }

    await supabase
      .from('appointments')
      .update({ 
        appointment_time: startTime.toISOString(),
        customer_name: customerName || oldAppointment.customer_name
      })
      .eq('id', appointmentId);

    if (oldAppointment.google_event_id && business.calendar_connected) {
      await updateGoogleCalendar(business, oldAppointment.google_event_id, startTime, duration);
    }

    console.log(`✅ Appointment rescheduled: ${appointmentId}`);

    const updatedAppointment = { ...oldAppointment, appointment_time: startTime.toISOString() };
    await notifyBusinessOwner(business, updatedAppointment, customerPhone, 'rescheduled');

    return true;

  } catch (error) {
    console.error('❌ Reschedule appointment error:', error);
    return false;
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
      summary: `תור - ${appointment.customer_name || customerPhone}`,
      description: `לקוח: ${appointment.customer_name || customerPhone}\nטלפון: ${customerPhone}\nנקבע דרך WhatsApp Bot`,
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

    await supabase
      .from('appointments')
      .update({ google_event_id: response.data.id })
      .eq('id', appointment.id);

    console.log(`✅ Added to Google Calendar: ${response.data.id}`);

  } catch (error) {
    console.error('❌ Calendar add error:', error);
  }
}

async function deleteFromGoogleCalendar(business, eventId) {
  try {
    if (!business.google_calendar_token) return;

    const tokens = JSON.parse(business.google_calendar_token);
    oauth2Client.setCredentials(tokens);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    await calendar.events.delete({
      calendarId: business.calendar_id || 'primary',
      eventId: eventId,
    });

    console.log(`✅ Deleted from Google Calendar: ${eventId}`);

  } catch (error) {
    console.error('❌ Calendar delete error:', error);
  }
}

async function updateGoogleCalendar(business, eventId, newStartTime, duration) {
  try {
    if (!business.google_calendar_token) return;

    const tokens = JSON.parse(business.google_calendar_token);
    oauth2Client.setCredentials(tokens);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const endTime = new Date(newStartTime.getTime() + duration * 60000);

    const event = {
      start: { dateTime: newStartTime.toISOString(), timeZone: 'Asia/Jerusalem' },
      end: { dateTime: endTime.toISOString(), timeZone: 'Asia/Jerusalem' },
    };

    await calendar.events.patch({
      calendarId: business.calendar_id || 'primary',
      eventId: eventId,
      resource: event,
    });

    console.log(`✅ Updated Google Calendar: ${eventId}`);

  } catch (error) {
    console.error('❌ Calendar update error:', error);
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
  console.log(`📱 WhatsApp Bot - Full System Ready!`);
  console.log(`🤖 OpenAI ChatGPT enabled`);
  console.log(`📅 Google Calendar sync every 5 minutes`);
  console.log(`🔔 Owner notifications enabled`);
  console.log(`✅ Cancel & Reschedule ready`);
  console.log(`📞 Business phone display enabled`);
});
