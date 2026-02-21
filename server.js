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

    for (const event of (response.data.items || [])) {
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
        console.log(`📅 Synced calendar event: ${event.summary}`);
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

setInterval(runCalendarSync, 5 * 60 * 1000);
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

    // 3. בטל תורים רפאים (unknown phone) מעל 3 חודשים קדימה
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

async function findFreeSlots(business, fromDate, count = 6) {
  const slots = [];
  const date = new Date(fromDate);
  date.setHours(9, 0, 0, 0);
  const duration = business.appointment_duration || 30;

  for (let day = 0; day < 14 && slots.length < count; day++) {
    const checkDate = new Date(date);
    checkDate.setDate(checkDate.getDate() + day);

    for (let hour = 9; hour < 18 && slots.length < count; hour++) {
      for (let min = 0; min < 60 && slots.length < count; min += duration) {
        const slot = new Date(checkDate);
        slot.setHours(hour, min, 0, 0);

        if (slot <= new Date()) continue;

        const conflict = await hasConflict(business.id, slot, duration);
        if (!conflict) slots.push(slot);
      }
    }
  }

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

  try {
    await sendWhatsAppMessage(business.owner_phone, msg);
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
    const freeSlots = await findFreeSlots(business, new Date(), 8);
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

⚠️ רשימת זמנים תפוסים (אלה בלבד תפוסים!):
${bookedList.length > 0 ? bookedList.join(' | ') : 'אין תורים תפוסים כלל'}

✅ זמנים פנויים - המקור היחיד לאמת!
כל זמן שלא ברשימת התפוסים = פנוי!
${freeSlotsText || 'אין זמנים פנויים'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
חוקים - חובה לעקוב בדיוק:

1. שאל שם מלא (פרטי + משפחה) לפני הכל.

2. ⚠️ כשהלקוח מבקש זמן - בדוק רק לפי רשימת התפוסים:
   • אם הזמן לא ברשימת התפוסים → פנוי! → שאל אישור ישירות. סיום.
   • אם הזמן ברשימת התפוסים → "לא פנוי" + 3 חלופות מהרשימה הפנויה באותה הודעה.
   ⚠️ אסור לך לקבוע לבד שזמן תפוס אם הוא לא ברשימת התפוסים!

3. זיכרון: אם הצעת "13:00 או 14:00" והלקוח ענה "13:00" → אל תשאל שוב, תאשר!

4. לפני קביעה: "מאשר תור ל[יום] [תאריך] בשעה [שעה]?"

5. אחרי "כן"/"אישור" - כתוב בשורה נפרדת בלבד:
   CONFIRM:2026-02-24T10:00:00|NAME:שם_מלא
   (העתק את הזמן בדיוק מהסוגריים [] ברשימה הפנויה!)

6. ביטול: CANCEL:ID | שינוי: RESCHEDULE:ID|NEW_TIME:ISO|NAME:שם
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ענה בעברית, קצר וברור.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      ...(historyOrdered || []).map(h => ({ role: h.role === 'user' ? 'user' : 'assistant', content: h.content })),
      { role: 'user', content: messageText }
    ];

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      max_tokens: 400,
      temperature: 0.3, // ✅ נמוך יותר = פחות "יצירתיות" = פחות טעויות
    });

    let aiMessage = completion.choices[0].message.content;
    console.log(`🤖 AI response: ${aiMessage}`);

    // שמור שיחה
    await supabase.from('conversations').insert([
      { business_id: business.id, customer_phone: customerPhone, role: 'user', content: messageText },
      { business_id: business.id, customer_phone: customerPhone, role: 'assistant', content: aiMessage }
    ]);

    // ── CONFIRM ──
    if (aiMessage.includes('CONFIRM:')) {
      const timeMatch = aiMessage.match(/CONFIRM:(?:ISO_)?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
      const nameMatch = aiMessage.match(/NAME:([^\n|CONFIRM]+)/);

      if (timeMatch) {
        const appointmentTime = timeMatch[1];
        const customerName = nameMatch ? nameMatch[1].trim() : null;

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
