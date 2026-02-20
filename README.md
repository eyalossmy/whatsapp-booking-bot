# 🤖 WhatsApp Booking Bot

בוט WhatsApp אוטומטי לקביעת תורים עם AI, מחובר ל-Google Calendar ומנהל תורים בזמן אמת.

---

## 🏗️ ארכיטקטורה

```
לקוח (WhatsApp) → Twilio → Webhook → Server (Node.js on Render)
                                           ↓
                                      OpenAI GPT-4o-mini
                                           ↓
                                    Supabase (PostgreSQL)
                                           ↓
                                    Google Calendar
```

---

## ✅ פיצ'רים קיימים

- קביעת תור אוטומטית עם AI בעברית
- וידוא שם מלא (פרטי + משפחה) לפני קביעה
- בדיקת זמינות מול DB בזמן אמת
- הצעת חלופות מיידית כשתור תפוס
- אישור תור לפני קביעה סופית
- סנכרון דו-כיווני עם Google Calendar (כל 5 דקות)
- התראה לבעל העסק ב-WhatsApp עם פרטי הלקוח
- ביטול תור + מחיקה מ-Calendar
- שינוי תור + עדכון Calendar
- ניקוי אוטומטי של תורים ישנים כל לילה בחצות
- ניקוי שיחות ישנות (מעל 30 יום)
- איפוס שיחה כשלקוח כותב "שלום"/"היי"
- מספר טלפון בפורמט ישראלי רגיל (05x)

---

## 🗄️ מבנה Database (Supabase)

### `businesses`
| עמודה | סוג | תיאור |
|-------|-----|--------|
| id | UUID | מזהה עסק |
| name | TEXT | שם העסק |
| whatsapp_number | TEXT | מספר Twilio |
| owner_phone | TEXT | טלפון בעל העסק |
| working_hours | TEXT | `09:00-18:00` |
| working_days | TEXT | `א-ה` |
| appointment_duration | INTEGER | משך תור בדקות |
| google_calendar_token | TEXT | JSON של OAuth tokens |
| calendar_connected | BOOLEAN | האם יומן מחובר |
| calendar_id | TEXT | `primary` |
| last_sync_time | TIMESTAMP | סנכרון אחרון |

### `appointments`
| עמודה | סוג | תיאור |
|-------|-----|--------|
| id | UUID | מזהה תור |
| business_id | UUID | FK → businesses |
| customer_phone | TEXT | טלפון לקוח |
| customer_name | TEXT | שם מלא לקוח |
| appointment_time | TIMESTAMP | זמן התור |
| duration | INTEGER | משך בדקות |
| status | TEXT | `pending` / `confirmed` / `cancelled` / `completed` |
| google_event_id | TEXT | ID של אירוע ב-Calendar |
| notes | TEXT | הערות |

### `conversations`
| עמודה | סוג | תיאור |
|-------|-----|--------|
| id | UUID | מזהה הודעה |
| business_id | UUID | FK → businesses |
| customer_phone | TEXT | טלפון לקוח |
| role | TEXT | `user` / `assistant` |
| content | TEXT | תוכן ההודעה |
| created_at | TIMESTAMP | זמן יצירה |

---

## 🔑 Environment Variables (Render)

```env
OPENAI_API_KEY=sk-proj-...
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_KEY=eyJ...
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_WHATSAPP_NUMBER=whatsapp:+14155238886
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
GOOGLE_REDIRECT_URI=https://whatsapp-booking-bot-godh.onrender.com/oauth2callback
PORT=3000
```

---

## 🌐 Endpoints

| Method | URL | תיאור |
|--------|-----|--------|
| GET | `/` | Health check |
| POST | `/webhook` | Twilio webhook לקבלת הודעות |
| GET | `/connect-calendar` | התחלת OAuth לחיבור Google Calendar |
| GET | `/oauth2callback` | Callback של Google OAuth |
| GET | `/debug/appointments` | הצג את כל התורים ב-DB |
| GET | `/debug/clean-old` | בטל תורים שעברו |
| GET | `/debug/cancel/:id` | בטל תור ספציפי לפי ID |

---

## 🔄 תהליכי עבודה

### קביעת תור
```
לקוח: "שלום"
בוט:  "היי! מה השם המלא שלך?"
לקוח: "איל אוסמי"
בוט:  "נעים מאוד איל! באיזה יום ושעה תרצה?"
לקוח: "יום שלישי ב-12:00"
בוט:  "מאשר תור ליום שלישי, 24 בפברואר בשעה 12:00?"
לקוח: "כן"
בוט:  "✅ מעולה איל אוסמי! התור נקבע..."
```

### תפוס → הצעת חלופות
```
לקוח: "יום שני ב-10:00"
בוט:  "יום שני 10:00 לא פנוי. הזמנים הפנויים הקרובים:
       • יום שני, 14:00
       • יום שלישי, 09:00
       • יום שלישי, 10:00
       איזה מתאים?"
```

### ביטול תור
```
לקוח: "אני רוצה לבטל את התור שלי"
בוט:  "מוצא את התור שלך... מאשר ביטול?"
לקוח: "כן"
בוט:  "✅ התור בוטל בהצלחה."
```

---

## ⚙️ תהליכים אוטומטיים

| תהליך | תדירות | תיאור |
|--------|---------|--------|
| סנכרון Calendar | כל 5 דקות | מוסיף תורים שנוצרו ידנית ביומן |
| ניקוי תורים עבריים | כל לילה בחצות | סטטוס → `completed` |
| ניקוי שיחות ישנות | כל לילה בחצות | מחיקת שיחות מעל 30 יום |
| ניקוי תורים רפאים | כל לילה בחצות | ביטול תורים ללא לקוח אמיתי |
| ניקוי בהפעלה | פעם אחת ב-startup | ניקוי מיידי בהפעלת השרת |

---

## 🐛 Debug - פתרון בעיות

### הבוט לא עונה
1. Render ב-Free tier ישן אחרי 15 דק' - שלח הודעה, חכה 30 שניות, שלח שוב
2. בדוק Render Logs
3. בדוק Webhook ב-Twilio Console

### "exceeded 50 messages"
- Twilio Sandbox מוגבל ל-50 הודעות ביום
- מתאפס כל 24 שעות
- פתרון קבוע: חיבור eSIM ל-Production

### הבוט אומר "תפוס" למרות שפנוי
1. פתח שיחה חדשה עם "שלום" - מנקה היסטוריה ישנה
2. בדוק תורים ב-DB:
   ```
   https://whatsapp-booking-bot-godh.onrender.com/debug/appointments
   ```
3. נקה תורים ישנים:
   ```
   https://whatsapp-booking-bot-godh.onrender.com/debug/clean-old
   ```

### תור לא מופיע ביומן Google
1. בדוק `calendar_connected = true` ב-DB
2. חפש בלוגים: `✅ Added to Google Calendar`
3. רענן את יומן Google

---

## 💰 עלויות נוכחיות

| שירות | תוכנית | עלות |
|--------|---------|------|
| GitHub | Free | ₪0 |
| Render | Free | ₪0 |
| Supabase | Free | ₪0 |
| Twilio | Sandbox | ₪0 |
| OpenAI | Pay-per-use | ~₪0.30 / 1000 הודעות |
| Google Cloud | Free | ₪0 |
| eSIM (Production) | - | ~₪15/חודש |

**סה"כ כרגע: ~₪0/חודש**

### כשיגדל לProduction
| שירות | עלות |
|--------|------|
| Render Starter | $7/חודש |
| Supabase Pro | $25/חודש |
| Twilio | $0.005/הודעה |
| OpenAI | $0.30/1000 הודעות |

---

## 🔜 פיצ'רים לפיתוח עתידי

- [ ] תזכורות אוטומטיות (24 שעות + שעה לפני)
- [ ] היסטוריית לקוח וזיהוי חוזר
- [ ] שירותים מרובים (משך שונה לכל שירות)
- [ ] תיק עבודות עם תמונות (Supabase Storage)
- [ ] Dashboard לבעל העסק
- [ ] חיבור eSIM לProduction
- [ ] תמיכה במספר עסקים (SaaS)

---

## 📋 Checklist לProduction

```
☐ חיבור eSIM ל-Twilio
☐ עדכון whatsapp_number ב-DB
☐ שדרוג Render ל-Starter ($7)
☐ בדיקות עם לקוח אמיתי
☐ לייב! 🚀
```

---

## 👤 פרטי פרויקט

- **בעל הפרויקט**: איל אוסמי (Eyal Ossmy)
- **GitHub**: [eyalossmy/whatsapp-booking-bot](https://github.com/eyalossmy/whatsapp-booking-bot)
- **Server**: [whatsapp-booking-bot-godh.onrender.com](https://whatsapp-booking-bot-godh.onrender.com)
