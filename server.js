require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// ============================================
// ROUTES
// ============================================

app.get('/', (req, res) => {
  res.send('🤖 WhatsApp Booking Bot - Running!');
});

// הצג את כל התורים ב-DB
app.get('/debug/appointments', async (req, res) => {
  const { data } = await supabase
    .from('appointments')
    .select('id, customer_name, customer_phone, appointment_time, duration, status, google_event_id')
    .order('appointment_time', { ascending: true });
  res.json(data || []);
});

// בטל את כל התורים הישנים (לפני עכשיו)
app.get('/debug/clean-old', async (req, res) => {
  const { error } = await supabase
    .from('appointments')
    .update({ status: 'cancelled' })
    .lt('appointment_time', new Date().toISOString())
    .in('status', ['pending', 'confirmed']);
  res.json({ message: 'Cleaned old appointments', error });
});

// בטל תור ספציפי לפי ID
app.get('/debug/cancel/:id', async (req, res) => {
  const { error } = await supabase
    .from('appointments')
    .update({ status: 'cancelled' })
    .eq('id', req.params.id);
  res.json({ message: `Cancelled ${req.params.id}`, error });
});

// ============================================
// CALENDAR SYNC - כל 5 דקות
// ============================================

async function syncCalendarForBusiness(business) {
  if (!business.google_calendar_token || !business.calendar_connected) return;

  try {
    const tokens = JSON.parse(business.google_calendar_token);
    oauth2Client.setCredentials(tokens);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const now = new Date();
    const future = new Date(now);
    future.setDate(future.getDate() + 30);

    const response = await calendar.events.list({
      calendarId: business.calendar_id || 'primary',
      timeMin: now.toISOString(),
      timeMax: future.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    const calendarEventIds = new Set(
      (response.data.items || [])
        .filter(e => e.start?.dateTime)
        .map(e => e.id)
    );

    // ── הוסף אירועים חדשים שלא ב-DB ──
    for (const event of response.data.items || []) {
      if (!event.start?.dateTime) continue;

      const { data: existing } = await supabase
        .from('appointments')
        .select('id')
        .eq('google_event_id', event.id)
        .single();

      if (!existing) {
        await supabase.from('appointments').insert({
          business_id: business.id,
          customer_phone: 'unknown',
          customer_name: event.summary || 'תור מיומן',
          appointment_time: new Date(event.start.dateTime).toISOString(),
          duration: business.appointment_duration || 30,
          status: 'confirmed',
          google_event_id: event.id,
          notes: 'נוצר ידנית ביומן Google'
        });
        console.log(`📅 Added from Calendar: ${event.summary}`);
      }
    }

    // ── בטל/עדכן תורים לפי מצב ביומן ──
    const { data: dbAppts } = await supabase
      .from('appointments')
      .select('id, google_event_id, customer_name, appointment_time')
      .eq('business_id', business.id)
      .in('status', ['pending', 'confirmed'])
      .gte('appointment_time', now.toISOString())
      .not('google_event_id', 'is', null);

    // בנה מפה של eventId → אירוע לצורך עדכון שעה
    const calendarEventMap = new Map(
      (response.data.items || [])
        .filter(e => e.start?.dateTime)
        .map(e => [e.id, e])
    );

    for (const appt of (dbAppts || [])) {
      const calEvent = calendarEventMap.get(appt.google_event_id);

      if (!calEvent) {
        // נמחק מהיומן - בטל ב-DB
        await supabase
          .from('appointments')
          .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
          .eq('id', appt.id);
        console.log(`🗑️ Cancelled (deleted from Calendar): ${appt.customer_name}`);
      } else {
        // עדכן שעה רק לתורים שנוצרו ידנית ביומן (לא דרך הבוט)
        if (appt.customer_phone === 'unknown') {
          const calTime = new Date(calEvent.start.dateTime).toISOString();
          const dbTime = new Date(appt.appointment_time).toISOString();
          if (calTime !== dbTime) {
            await supabase
              .from('appointments')
              .update({ appointment_time: calTime })
              .eq('id', appt.id);
            console.log(`🔄 Updated manual appointment time: ${appt.customer_name} → ${calTime}`);
          }
        }
      }
    }

    await supabase
      .from('businesses')
      .update({ last_sync_time: new Date().toISOString() })
      .eq('id', business.id);

  } catch (error) {
    console.error(`❌ Calendar sync error:`, error.message);
  }
}

async function runCalendarSync() {
  try {
    const { data: businesses } = await supabase
      .from('businesses')
      .select('*')
      .eq('calendar_connected', true);

    if (businesses?.length > 0) {
      console.log(`🔄 Syncing ${businesses.length} calendars...`);
      for (const b of businesses) await syncCalendarForBusiness(b);
    }
  } catch (error) {
    console.error('❌ Sync job error:', error);
  }
}

setInterval(runCalendarSync, 60 * 1000); // כל דקה
setTimeout(runCalendarSync, 10000);

// ============================================
// AUTO CLEANUP - ניקוי אוטומטי
// ============================================

async function runAutoCleanup() {
  try {
    const now = new Date();

    // 1. סמן תורים שעברו כ-completed
    const { data: oldAppts } = await supabase
      .from('appointments')
      .update({ status: 'completed' })
      .lt('appointment_time', now.toISOString())
      .in('status', ['pending', 'confirmed'])
      .select('id');
    if (oldAppts?.length > 0) console.log('🧹 Completed ' + oldAppts.length + ' past appointments');

    // 2. מחק שיחות ישנות מעל 30 יום
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    await supabase.from('conversations').delete().lt('created_at', thirtyDaysAgo.toISOString());
    console.log('🧹 Cleaned old conversations');

    // 3. בטל תורים עם שמות placeholder מבדיקות
    const placeholderNames = ['שמך', 'לקוח', 'שם_מלא_הלקוח', 'שם_הלקוח', 'שם', 'test', 'unknown'];
    for (const name of placeholderNames) {
      await supabase.from('appointments')
        .update({ status: 'cancelled' })
        .eq('customer_name', name)
        .in('status', ['pending', 'confirmed']);
    }
    console.log('🧹 Cleaned placeholder appointments');

    // 4. בטל תורים רפאים (unknown phone) מעל 3 חודשים קדימה
    const threeMonths = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
    await supabase.from('appointments').update({ status: 'cancelled' })
      .eq('customer_phone', 'unknown').gt('appointment_time', threeMonths.toISOString());
    console.log('🧹 Cleaned ghost appointments');

  } catch (err) {
    console.error('❌ Cleanup error:', err.message);
  }
}

// ניקוי כל לילה בחצות
function scheduleNightlyCleanup() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  const ms = midnight.getTime() - now.getTime();
  console.log('🕛 Nightly cleanup in ' + Math.round(ms / 60000) + ' min');
  setTimeout(() => {
    runAutoCleanup();
    setInterval(runAutoCleanup, 24 * 60 * 60 * 1000);
  }, ms);
}

scheduleNightlyCleanup();
setTimeout(runAutoCleanup, 5000); // ניקוי גם בהפעלה



// ============================================
// CONFLICT CHECK
// ============================================

async function hasConflict(businessId, requestedTime, duration) {
  const startTime = new Date(requestedTime);
  const endTime = new Date(startTime.getTime() + duration * 60000);

  console.log(`🔍 Conflict check: ${startTime.toISOString()} → ${endTime.toISOString()}`);

  const { data: appointments, error } = await supabase
    .from('appointments')
    .select('id, customer_name, appointment_time, duration, status')
    .eq('business_id', businessId)
    .in('status', ['pending', 'confirmed'])
    .gte('appointment_time', new Date(startTime.getTime() - 2 * 60 * 60 * 1000).toISOString())
    .lte('appointment_time', new Date(endTime.getTime() + 2 * 60 * 60 * 1000).toISOString());

  if (error) {
    console.error('❌ Supabase error in hasConflict:', error);
    return false;
  }

  console.log(`📋 Checking ${appointments?.length || 0} nearby appointments`);

  for (const appt of (appointments || [])) {
    const apptStart = new Date(appt.appointment_time);
    const apptEnd = new Date(apptStart.getTime() + (appt.duration || 30) * 60000);
    const overlaps = startTime < apptEnd && endTime > apptStart;

    console.log(`  📌 [${appt.status}] ${appt.customer_name} @ ${apptStart.toISOString()} → overlap: ${overlaps}`);

    if (overlaps) {
      console.log(`⚠️ CONFLICT with: ${appt.customer_name}`);
      return true;
    }
  }

  console.log(`✅ Slot is FREE`);
  return false;
}

// ============================================
// FIND FREE SLOTS
// ============================================

async function findFreeSlots(business, fromDate, count = 6, preferredHour = null) {
  const duration = business.appointment_duration || 30;
  const now = new Date();

  // בנה רשימת כל הסלוטים האפשריים ב-14 ימים קדימה
  const allSlots = [];
  const startDate = new Date(fromDate);
  startDate.setHours(9, 0, 0, 0);

  for (let day = 0; day < 14; day++) {
    const checkDate = new Date(startDate);
    checkDate.setDate(checkDate.getDate() + day);
    for (let hour = 9; hour < 18; hour++) {
      for (let min = 0; min < 60; min += duration) {
        const slot = new Date(checkDate);
        slot.setHours(hour, min, 0, 0);
        if (slot > now) allSlots.push(slot);
      }
    }
  }

  // מיין: קודם לפי קרבה בשעה, ואז לפי קרבה בתאריך
  if (preferredHour !== null) {
    allSlots.sort((a, b) => {
      const aHourDiff = Math.abs(a.getHours() + a.getMinutes()/60 - preferredHour);
      const bHourDiff = Math.abs(b.getHours() + b.getMinutes()/60 - preferredHour);
      // אם ההפרש בשעה זהה (פחות מ-0.01) - מוקדם יותר קודם
      if (Math.abs(aHourDiff - bHourDiff) < 0.01) return a - b;
      return aHourDiff - bHourDiff;
    });
  }

  // בדוק זמינות וקח את ה-count הראשונים
  const slots = [];
  for (const slot of allSlots) {
    if (slots.length >= count) break;
    const conflict = await hasConflict(business.id, slot, duration);
    if (!conflict) slots.push(slot);
  }

  // מיין את התוצאות הסופיות כרונולוגית לתצוגה נכונה
  slots.sort((a, b) => a - b);
  return slots;
}

// ============================================
// SEND WHATSAPP
// ============================================

async function sendWhatsAppMessage(to, message) {
  const toNumber = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
  const fromNumber = process.env.TWILIO_WHATSAPP_NUMBER || 'whatsapp:+14155238886';

  const result = await twilioClient.messages.create({
    from: fromNumber,
    to: toNumber,
    body: message
  });

  console.log(`✅ Message sent: ${result.sid}`);
  return result;
}

// ============================================
// NOTIFY BUSINESS OWNER
// ============================================

async function notifyOwner(business, appointment, customerPhone, action = 'new') {
  if (!business.owner_phone) return;

  const t = new Date(appointment.appointment_time);
  const dayName = t.toLocaleDateString('he-IL', { weekday: 'long' });
  const date = t.toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' });
  const time = t.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  const name = appointment.customer_name || customerPhone;

  // מספר טלפון בפורמט ישראלי רגיל
  const phone = customerPhone.replace(/^\+?972/, '0');

  let msg = '';
  if (action === 'new') {
    msg = `🔔 תור חדש ב${business.name}!\n\n👤 ${name}\n📞 ${phone}\n📅 ${dayName}, ${date}\n🕐 ${time}\n⏱️ ${appointment.duration} דקות\n\n✅ נוסף ליומן Google.`;
  } else if (action === 'cancelled') {
    msg = `❌ תור בוטל ב${business.name}\n\n👤 ${name}\n📞 ${phone}\n📅 ${dayName}, ${date}\n🕐 ${time}\n\nהוסר מהיומן.`;
  } else if (action === 'rescheduled') {
    msg = `🔄 תור שונה ב${business.name}\n\n👤 ${name}\n📞 ${phone}\n📅 ${dayName}, ${date}\n🕐 ${time}\n\nהיומן עודכן.`;
  }

  // המר לפורמט בינלאומי רק לצורך השליחה - ה-DB נשאר כמו שהוא
  let ownerPhone = business.owner_phone.toString().trim();
  if (ownerPhone.startsWith('05')) ownerPhone = '+972' + ownerPhone.slice(1);
  else if (ownerPhone.startsWith('5')) ownerPhone = '+972' + ownerPhone;
  else if (!ownerPhone.startsWith('+')) ownerPhone = '+' + ownerPhone;

  try {
    await sendWhatsAppMessage(ownerPhone, msg);
    console.log(`✅ Owner notified`);
  } catch (err) {
    console.error(`❌ Owner notification failed:`, err.message);
  }
}

// ============================================
// GOOGLE CALENDAR
// ============================================

async function addToCalendar(business, appointment, customerPhone) {
  if (!business.google_calendar_token || !business.calendar_connected) return;
  try {
    const tokens = JSON.parse(business.google_calendar_token);
    oauth2Client.setCredentials(tokens);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const start = new Date(appointment.appointment_time);
    const end = new Date(start.getTime() + appointment.duration * 60000);

    const event = {
      summary: `תור - ${appointment.customer_name || customerPhone}`,
      description: `לקוח: ${appointment.customer_name || customerPhone}\nטלפון: ${customerPhone.replace(/^\+?972/, '0')}\nנקבע דרך WhatsApp Bot`,
      start: { dateTime: start.toISOString(), timeZone: 'Asia/Jerusalem' },
      end: { dateTime: end.toISOString(), timeZone: 'Asia/Jerusalem' },
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 60 }] },
    };

    const res = await calendar.events.insert({
      calendarId: business.calendar_id || 'primary',
      resource: event,
    });

    await supabase.from('appointments').update({ google_event_id: res.data.id }).eq('id', appointment.id);
    console.log(`✅ Added to Google Calendar: ${res.data.id}`);
  } catch (err) {
    console.error('❌ Calendar add error:', err.message);
  }
}

async function deleteFromCalendar(business, eventId) {
  if (!business.google_calendar_token || !eventId) return;
  try {
    const tokens = JSON.parse(business.google_calendar_token);
    oauth2Client.setCredentials(tokens);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    await calendar.events.delete({ calendarId: business.calendar_id || 'primary', eventId });
    console.log(`✅ Deleted from Google Calendar: ${eventId}`);
  } catch (err) {
    console.error('❌ Calendar delete error:', err.message);
  }
}

async function updateCalendar(business, eventId, newStart, duration) {
  if (!business.google_calendar_token || !eventId) return;
  try {
    const tokens = JSON.parse(business.google_calendar_token);
    oauth2Client.setCredentials(tokens);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const end = new Date(newStart.getTime() + duration * 60000);
    await calendar.events.patch({
      calendarId: business.calendar_id || 'primary',
      eventId,
      resource: {
        start: { dateTime: newStart.toISOString(), timeZone: 'Asia/Jerusalem' },
        end: { dateTime: end.toISOString(), timeZone: 'Asia/Jerusalem' },
      },
    });
    console.log(`✅ Updated Google Calendar: ${eventId}`);
  } catch (err) {
    console.error('❌ Calendar update error:', err.message);
  }
}

// ============================================
// APPOINTMENT CRUD
// ============================================

async function createAppointment(business, customerPhone, appointmentTime, customerName) {
  const start = new Date(appointmentTime);
  const duration = business.appointment_duration || 30;

  const conflict = await hasConflict(business.id, start, duration);
  if (conflict) {
    console.log('⚠️ Conflict - appointment NOT created');
    return null;
  }

  const { data: appt, error } = await supabase
    .from('appointments')
    .insert({
      business_id: business.id,
      customer_phone: customerPhone,
      customer_name: customerName,
      appointment_time: start.toISOString(),
      duration,
      status: 'confirmed',
      confirmed_at: new Date().toISOString()
    })
    .select()
    .single();

  if (error) {
    console.error('❌ Insert error:', error);
    return null;
  }

  console.log(`✅ Appointment created: ${appt.id}`);
  await addToCalendar(business, appt, customerPhone);
  await notifyOwner(business, appt, customerPhone, 'new');
  return appt;
}

async function cancelAppointment(business, appointmentId, customerPhone) {
  const { data: appt } = await supabase
    .from('appointments')
    .select('*')
    .eq('id', appointmentId)
    .eq('business_id', business.id)
    .single();

  if (!appt) return false;

  await deleteFromCalendar(business, appt.google_event_id);
  await supabase.from('appointments').update({ status: 'cancelled', cancelled_at: new Date().toISOString() }).eq('id', appointmentId);
  await notifyOwner(business, appt, customerPhone, 'cancelled');
  console.log(`✅ Appointment cancelled: ${appointmentId}`);
  return true;
}

async function rescheduleAppointment(business, appointmentId, newTime, customerPhone, customerName) {
  const { data: old } = await supabase
    .from('appointments')
    .select('*')
    .eq('id', appointmentId)
    .eq('business_id', business.id)
    .single();

  if (!old) return false;

  const start = new Date(newTime);
  const duration = business.appointment_duration || 30;

  const conflict = await hasConflict(business.id, start, duration);
  if (conflict) return false;

  await supabase.from('appointments').update({
    appointment_time: start.toISOString(),
    customer_name: customerName || old.customer_name
  }).eq('id', appointmentId);

  await updateCalendar(business, old.google_event_id, start, duration);
  await notifyOwner(business, { ...old, appointment_time: start.toISOString() }, customerPhone, 'rescheduled');
  console.log(`✅ Appointment rescheduled: ${appointmentId}`);
  return true;
}


// ============================================
// AVAILABILITY CHECK - הקוד בודק, לא ה-AI
// ============================================

function parseRequestedTime(text, now) {
  // חפש שעה בטקסט: "12:00", "12", "ב-12"
  const timeMatch = text.match(/(?:ב-?|בשעה\s*)?(\d{1,2})[:\.]?(\d{2})?(?:\s*(?:בצהריים|בבוקר|בערב))?/);
  if (!timeMatch) return null;

  const hour = parseInt(timeMatch[1]);
  const min = parseInt(timeMatch[2] || '0');
  if (hour < 6 || hour > 22) return null;

  // חפש יום בטקסט
  const dayMap = {
    'ראשון': 0, 'שני': 1, 'שלישי': 2, 'רביעי': 3,
    'חמישי': 4, 'שישי': 5, 'שבת': 6,
    'היום': now.getDay(), 'מחר': (now.getDay() + 1) % 7
  };

  let targetDate = null;
  for (const [name, dayNum] of Object.entries(dayMap)) {
    if (text.includes(name)) {
      targetDate = new Date(now);
      let daysAhead = dayNum - now.getDay();
      if (name === 'היום') daysAhead = 0;
      else if (name === 'מחר') daysAhead = 1;
      else if (daysAhead <= 0) daysAhead += 7;
      targetDate.setDate(targetDate.getDate() + daysAhead);
      break;
    }
  }

  // אם לא מצא יום - קח הכי קרוב בעתיד
  if (!targetDate) {
    targetDate = new Date(now);
    const slotToday = new Date(now);
    slotToday.setHours(hour, min, 0, 0);
    if (slotToday <= now) targetDate.setDate(targetDate.getDate() + 1);
  }

  targetDate.setHours(hour, min, 0, 0);
  return targetDate > now ? targetDate : null;
}

async function checkAndInjectAvailability(messageText, business, historyOrdered, now) {
  // רק אם הלקוח מבקש זמן ספציפי
  const hasTime = /\d{1,2}[:\.]?\d{0,2}/.test(messageText);
  const isBookingIntent = /תור|פנוי|שעה|קבוע|זמין|ב-\d|ב\d/.test(messageText) || hasTime;
  if (!isBookingIntent) return null;

  const requestedTime = parseRequestedTime(messageText, now);
  if (!requestedTime) return null;

  const duration = business.appointment_duration || 30;
  const isFree = !(await hasConflict(business.id, requestedTime, duration));

  const dayName = requestedTime.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' });
  const timeStr = requestedTime.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  const iso = requestedTime.toISOString().slice(0, 19);

  console.log(`🔎 Requested: ${iso} → ${isFree ? 'FREE' : 'BUSY'}`);

  if (isFree) {
    return `[מערכת: הזמן ${dayName} ${timeStr} פנוי. ISO: ${iso}]`;
  } else {
    // מצא חלופות קרובות בשעה
    const preferredHour = requestedTime.getHours() + requestedTime.getMinutes() / 60;
    const alts = await findFreeSlots(business, now, 3, preferredHour);
    const altText = alts.map(s => {
      const h = s.toLocaleString('he-IL', { weekday: 'long', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
      return `${h} [${s.toISOString().slice(0,19)}]`;
    }).join(', ');
    return `[מערכת: הזמן ${dayName} ${timeStr} תפוס. חלופות קרובות: ${altText}]`;
  }
}

// ============================================
// OPENAI
// ============================================

async function processWithAI(messageText, customerPhone, business) {
  try {
    // זיהוי פתיחת שיחה חדשה - נקה היסטוריה ישנה
    const greetings = ['שלום', 'היי', 'הי', 'בוקר טוב', 'ערב טוב', 'hello', 'hi'];
    const isNewSession = greetings.some(g => messageText.trim().startsWith(g));
    if (isNewSession) {
      await supabase.from('conversations')
        .delete()
        .eq('customer_phone', customerPhone)
        .eq('business_id', business.id);
      console.log('🔄 New session detected - cleared conversation history');
    }

    // שלוף היסטוריית שיחה - רק 6 הודעות אחרונות
    const { data: history } = await supabase
      .from('conversations')
      .select('role, content')
      .eq('customer_phone', customerPhone)
      .eq('business_id', business.id)
      .order('created_at', { ascending: false })
      .limit(6);
    const historyOrdered = (history || []).reverse();

    // בדוק אם יש תור קיים ללקוח
    const { data: existingAppts } = await supabase
      .from('appointments')
      .select('*')
      .eq('business_id', business.id)
      .eq('customer_phone', customerPhone)
      .in('status', ['pending', 'confirmed'])
      .gte('appointment_time', new Date().toISOString())
      .order('appointment_time')
      .limit(1);

    // תורים תפוסים (להציג ל-AI)
    const { data: booked } = await supabase
      .from('appointments')
      .select('appointment_time, duration')
      .eq('business_id', business.id)
      .in('status', ['pending', 'confirmed'])
      .gte('appointment_time', new Date().toISOString())
      .order('appointment_time')
      .limit(30);

    const bookedList = (booked || []).map(s =>
      new Date(s.appointment_time).toLocaleString('he-IL', {
        weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit'
      })
    );

    // זמנים פנויים - עם ISO לשימוש ב-CONFIRM
    // חלץ שעה מבוקשת מהיסטוריית השיחה (עד 3 הודעות אחרונות)
    let preferredHour = null;
    const allTexts = [...(historyOrdered || []).slice(-3).map(h => h.content), messageText].join(' ');
    const hourMatch = allTexts.match(/(\d{1,2})[:\.](\d{2})/);
    if (hourMatch) {
      preferredHour = parseInt(hourMatch[1]) + parseInt(hourMatch[2]) / 60;
    }
    const freeSlots = await findFreeSlots(business, new Date(), 8, preferredHour);
    const freeSlotsText = freeSlots.map(s => {
      const hebrew = s.toLocaleString('he-IL', {
        weekday: 'long', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit'
      });
      const iso = s.toISOString().slice(0, 19);
      return `• ${hebrew}  [${iso}]`;
    }).join('\n');

    // תאריכים קרובים לעזור ל-AI
    const now = new Date();
    const todayStr = now.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const nextDays = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(now);
      d.setDate(d.getDate() + i);
      return `${d.toLocaleDateString('he-IL', { weekday: 'long' })} = ${d.toISOString().split('T')[0]}`;
    }).join('\n');

    // תור קיים של הלקוח
    let existingInfo = '';
    if (existingAppts?.length > 0) {
      const a = existingAppts[0];
      const t = new Date(a.appointment_time);
      existingInfo = `\nללקוח יש תור קיים: ${t.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' })} בשעה ${t.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })} | ID: ${a.id}`;
    }

    const systemPrompt = `אתה עוזר לקביעת תורים עבור ${business.name}.

היום: ${todayStr} | שעה: ${now.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}

ימים קרובים:
${nextDays}

פרטי עסק:
- שעות: ${business.working_hours || '09:00-18:00'}
- משך תור: ${business.appointment_duration || 30} דקות
- ימי עבודה: ${business.working_days || 'א-ה'}
${business.owner_phone ? `- טלפון: ${business.owner_phone}` : ''}
${existingInfo}

זמנים פנויים:
${freeSlotsText || 'אין זמנים פנויים'}

תורים תפוסים: ${bookedList.length > 0 ? bookedList.join(' | ') : 'אין'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
חוקים:

1. שאל שם מלא (פרטי + משפחה) לפני הכל.

2. כשהלקוח מבקש זמן:
   המערכת תוסיף הערה [מערכת: ...] עם סטטוס הזמן וחלופות.
   אם [מערכת: פנוי] → שאל אישור עם התאריך המדויק מה-ISO שבסוגריים.
   אם [מערכת: תפוס] → אמור שתפוס + הצע את החלופות מהרשימה שבהערה.
   אסור לך להחליט בעצמך אם פנוי או תפוס - רק לפי הערת המערכת!

3. אם הצעת זמנים והלקוח בחר אחד → אשר ישירות בלי לשאל שוב.

4. לפני קביעה: "מאשר תור ל[יום] [תאריך] בשעה [שעה]?"

5. אחרי "כן"/"אישור":
   CONFIRM:[זמן מהרשימה]|NAME:שם_מלא

6. ביטול: CANCEL:ID | שינוי: RESCHEDULE:ID|NEW_TIME:ISO|NAME:שם
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ענה בעברית, קצר וברור.`;

    // בדיקת זמינות בקוד - הוסף הודעת מערכת ל-AI
    const availabilityNote = await checkAndInjectAvailability(messageText, business, historyOrdered, now);
    const userContent = availabilityNote
      ? `${messageText}\n${availabilityNote}`
      : messageText;

    const messages = [
      { role: 'system', content: systemPrompt },
      ...(historyOrdered || []).map(h => ({ role: h.role === 'user' ? 'user' : 'assistant', content: h.content })),
      { role: 'user', content: userContent }
    ];

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      max_tokens: 400,
      temperature: 0.1,
    });

    let aiMessage = completion.choices[0].message.content;
    // הסר הערות מערכת שדלפו לתשובה
    aiMessage = aiMessage.replace(/\[מערכת:[^\]]*\]/g, '').trim();
    console.log(`🤖 AI response: ${aiMessage}`);

    // ✅ תיקון: אם ה-AI אמר "תפוס"/"לא פנוי" - בדוק בעצמנו!
    const saidBusy = /תפוס|לא פנוי|אינו פנוי|אין פנוי/.test(aiMessage);
    if (saidBusy && !aiMessage.includes('CONFIRM')) {
      // נסה לחלץ זמן מהודעת המשתמש
      const timeMatch = messageText.match(/(\d{1,2})[:\.](\d{2})/);
      if (timeMatch) {
        const requestedHour = parseInt(timeMatch[1]);
        const requestedMin = parseInt(timeMatch[2]);

        // בנה תאריכים לבדיקה - היום ו-7 ימים קדימה
        for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
          const checkDate = new Date(now);
          checkDate.setDate(checkDate.getDate() + dayOffset);
          checkDate.setHours(requestedHour, requestedMin, 0, 0);
          if (checkDate <= now) continue;

          const conflict = await hasConflict(business.id, checkDate, business.appointment_duration || 30);
          if (!conflict) {
            console.log(`✅ CODE CHECK: ${checkDate.toISOString()} is actually FREE - AI was wrong!`);
            // override - הזמן פנוי, המשך כרגיל
            break;
          }
        }
      }
    }

    // שמור שיחה
    await supabase.from('conversations').insert([
      { business_id: business.id, customer_phone: customerPhone, role: 'user', content: messageText },
      { business_id: business.id, customer_phone: customerPhone, role: 'assistant', content: aiMessage }
    ]);

    // ── CONFIRM ──
    if (aiMessage.includes('CONFIRM:')) {
      const timeMatch = aiMessage.match(/CONFIRM:(?:ISO_)?\[?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\]?/);
      const nameMatch = aiMessage.match(/NAME:([^|\n]+)/);


      if (timeMatch) {
        let appointmentTime = timeMatch[1];
        const customerName = nameMatch ? nameMatch[1].trim() : null;

        // ✅ וודא שה-CONFIRM תואם למה שה-AI אמר בטקסט
        // חלץ שעה מהטקסט ("מאשר תור ל...10:00" / "בשעה 10:00")
        const saidTimeMatch = aiMessage.match(/בשעה\s+(\d{1,2})[:\.]?(\d{2})?/);
        if (saidTimeMatch) {
          const saidHour = parseInt(saidTimeMatch[1]).toString().padStart(2, '0');
          const saidMin = (saidTimeMatch[2] || '00').padStart(2, '0');
          const confirmHour = appointmentTime.slice(11, 13);
          const confirmMin = appointmentTime.slice(14, 16);

          if (saidHour !== confirmHour || saidMin !== confirmMin) {
            console.log(`⚠️ MISMATCH: AI said ${saidHour}:${saidMin} but CONFIRM has ${confirmHour}:${confirmMin} - fixing!`);
            appointmentTime = appointmentTime.slice(0, 11) + saidHour + ':' + saidMin + ':00';
            console.log(`✅ Fixed appointmentTime to: ${appointmentTime}`);
          }
        }

        // ✅ וודא שהשם לא הועתק מהדוגמה
        const isPlaceholder = !customerName || 
          customerName.includes('שם_מלא') || 
          customerName.includes('שם_הלקוח') ||
          customerName === 'שם';

        if (isPlaceholder) {
          console.log('⚠️ AI used placeholder name - asking for real name');
          aiMessage = 'מה השם המלא שלך? (שם פרטי + שם משפחה)';
        } else {
          console.log(`📅 Creating appointment: ${appointmentTime} for "${customerName}"`);
          const appt = await createAppointment(business, customerPhone, appointmentTime, customerName);

          if (appt) {
            const d = new Date(appointmentTime);
            const dayName = d.toLocaleDateString('he-IL', { weekday: 'long' });
            const dateStr = d.toLocaleDateString('he-IL', { day: 'numeric', month: 'long' });
            const timeStr = d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });

            aiMessage = `✅ מעולה ${customerName}! התור נקבע.\n\n` +
              `📅 ${dayName}, ${dateStr}\n` +
              `🕐 שעה: ${timeStr}\n` +
              `⏱️ משך: ${business.appointment_duration || 30} דקות\n\n` +
              `📍 ${business.name}\n` +
              (business.owner_phone ? `📞 ${business.owner_phone}\n\n` : '\n') +
              `נתראה! 👋`;
          } else {
            aiMessage = '❌ הזמן שנבחר כבר תפוס. בחר זמן אחר מהרשימה.';
          }
        }
      }
    }

    // ── CANCEL ──
    if (aiMessage.includes('CANCEL:')) {
      const match = aiMessage.match(/CANCEL:([a-f0-9-]{36})/);
      if (match) {
        await cancelAppointment(business, match[1], customerPhone);
        aiMessage = '✅ התור בוטל בהצלחה.';
      }
    }

    // ── RESCHEDULE ──
    if (aiMessage.includes('RESCHEDULE:')) {
      const match = aiMessage.match(/RESCHEDULE:([a-f0-9-]{36})\|NEW_TIME:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
      const nameMatch = aiMessage.match(/NAME:([^\n|]+)/);
      if (match) {
        const success = await rescheduleAppointment(business, match[1], match[2], customerPhone, nameMatch?.[1]?.trim());
        aiMessage = success ? '✅ התור שונה בהצלחה!' : '❌ הזמן החדש תפוס. בחר זמן אחר.';
      }
    }

    return aiMessage;

  } catch (error) {
    console.error('❌ AI error:', error);
    return 'מצטער, נתקלתי בבעיה. אנא נסה שוב.';
  }
}

// ============================================
// TWILIO WEBHOOK
// ============================================

app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // תמיד ענה מהר ל-Twilio

  try {
    const messageBody = req.body.Body;
    const from = req.body.From;
    const to = req.body.To;

    if (!messageBody) return;

    const customerPhone = from.replace('whatsapp:', '');
    const businessPhone = to.replace('whatsapp:', '');

    console.log(`\n📥 [${new Date().toLocaleTimeString('he-IL')}] From: ${customerPhone} | Msg: "${messageBody}"`);

    const { data: business } = await supabase
      .from('businesses')
      .select('*')
      .eq('whatsapp_number', businessPhone)
      .single();

    if (!business) {
      console.log(`❌ No business found for: ${businessPhone}`);
      await sendWhatsAppMessage(customerPhone, 'מצטער, המערכת בהגדרה.');
      return;
    }

    console.log(`✅ Business: ${business.name}`);
    const reply = await processWithAI(messageBody, customerPhone, business);
    await sendWhatsAppMessage(customerPhone, reply);

  } catch (error) {
    console.error('❌ Webhook error:', error);
  }
});

// ============================================
// OAUTH - חיבור Google Calendar
// ============================================

app.get('/connect-calendar', (req, res) => {
  const { business_id } = req.query;
  if (!business_id) return res.send('❌ Missing business_id');

  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar'],
    state: business_id
  });
  res.redirect(url);
});

app.get('/oauth2callback', async (req, res) => {
  const { code, state: businessId } = req.query;
  if (!code) return res.send('❌ Authorization failed');

  try {
    const { tokens } = await oauth2Client.getToken(code);
    await supabase.from('businesses').update({
      google_calendar_token: JSON.stringify(tokens),
      calendar_connected: true
    }).eq('id', businessId);

    res.send(`<html><body style="font-family:Arial;text-align:center;padding:50px">
      <h1>✅ היומן חובר בהצלחה!</h1>
      <p>כל התורים יתווספו אוטומטית ליומן Google שלך.</p>
      <p>אפשר לסגור דף זה.</p>
    </body></html>`);
  } catch (err) {
    console.error('OAuth error:', err);
    res.send('❌ שגיאה בחיבור יומן');
  }
});

// ============================================
// START
// ============================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Bot running on port ${PORT}`);
  console.log(`📱 Ready to receive WhatsApp messages`);
});
