# WhatsApp Booking Bot 🤖

מערכת אוטומטית לקביעת תורים דרך WhatsApp עם בינה מלאכותית.

## תכונות ✨

- ✅ קביעת תורים אוטומטית 24/7
- ✅ תזכורות אוטומטיות
- ✅ שיחה טבעית עם לקוחות (AI)
- ✅ ניהול מספר עסקים
- ✅ מסד נתונים מאובטח

## דרישות מקדימות 📋

1. **Node.js** (גרסה 18 ומעלה)
2. חשבונות בשירותים:
   - GitHub
   - Render (לשרת)
   - Supabase (מסד נתונים)
   - Google AI Studio (Gemini API)
   - 360dialog (WhatsApp Business API)

## הגדרת Supabase 🗄️

צור את הטבלאות הבאות ב-Supabase:

### טבלה: `businesses`
```sql
CREATE TABLE businesses (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  whatsapp_phone_id TEXT UNIQUE,
  whatsapp_number TEXT,
  working_hours TEXT DEFAULT '09:00-18:00',
  working_days TEXT DEFAULT 'א-ה',
  appointment_duration INTEGER DEFAULT 30,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### טבלה: `appointments`
```sql
CREATE TABLE appointments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id UUID REFERENCES businesses(id),
  customer_phone TEXT NOT NULL,
  customer_name TEXT,
  appointment_time TIMESTAMP NOT NULL,
  duration INTEGER DEFAULT 30,
  status TEXT DEFAULT 'confirmed',
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### טבלה: `conversations`
```sql
CREATE TABLE conversations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id UUID REFERENCES businesses(id),
  customer_phone TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
```

## התקנה מקומית 💻

1. שכפל את הקוד:
```bash
git clone https://github.com/YOUR_USERNAME/whatsapp-booking-bot.git
cd whatsapp-booking-bot
```

2. התקן תלויות:
```bash
npm install
```

3. צור קובץ `.env`:
```bash
cp .env.example .env
```

4. מלא את ה-API Keys בקובץ `.env`:
   - GEMINI_API_KEY (מ-Google AI Studio)
   - SUPABASE_URL ו-SUPABASE_KEY (מ-Supabase)
   - DIALOG_360_API_KEY (מ-360dialog)
   - WEBHOOK_VERIFY_TOKEN (תמציא סיסמה חזקה)

5. הרץ את השרת:
```bash
npm start
```

## פריסה ל-Render 🚀

1. חבר את GitHub ל-Render
2. צור Web Service חדש
3. בחר את ה-Repository
4. הגדרות:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
5. הוסף Environment Variables מקובץ `.env`
6. Deploy!

## הגדרת 360dialog 📱

1. לך ל-360dialog Dashboard
2. הוסף את מספר ה-WhatsApp שלך
3. הגדר Webhook:
   - URL: `https://your-app.onrender.com/webhook`
   - Verify Token: (אותו ב-`.env`)
4. שמור

## הוספת עסק חדש 🏪

הוסף שורה ל-`businesses` ב-Supabase:
```sql
INSERT INTO businesses (name, whatsapp_phone_id, whatsapp_number)
VALUES ('שם העסק', 'phone_number_id_from_360dialog', '972501234567');
```

## בדיקה ✅

שלח הודעה למספר WhatsApp Business:
```
"היי, אני רוצה לקבוע תור"
```

הבוט אמור להגיב!

## תמיכה 💬

יצירת issue ב-GitHub או פנייה למפתח.

---

Made with ❤️ for small businesses
