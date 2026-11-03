# מחולל הצעות מחיר · NeoTech Vision

אפליקציה קטנה עם שרת ומסד נתונים (Node + SQLite) שמפיקה הצעות מחיר בעיצוב NeoTech Vision,
ונותנת ללקוח קישור אישי שנפתח **רק אחרי הזנת מספר הטלפון שלו** (הבדיקה בצד השרת).

## מה יש בפנים

| כתובת | למי | מה |
|---|---|---|
| `/admin` | אתה | רשימת ההצעות, סטטוס, צפיות, כפתור "העתק קישור" ו-"WhatsApp" |
| `/admin/new` | אתה | טופס הצעה חדשה – לקוח, טלפון, כותרת, תיאור, רכיבים, שלבים, פריסת תשלומים, תנאים |
| `/admin/settings` | אתה | פרטי החברה, מע"מ, תוקף, קידומת ומספר רץ |
| `/q/HM-2026-0079` | הלקוח | דף הזנת טלפון → ההצעה המלאה → אישור וחתימה דיגיטלית |

* מספר ההצעה נוצר אוטומטית (HM-2026-0079, 0080 ...).
* כל ניסיון כניסה נרשם (טלפון שהוזן, הצלחה/כישלון) ומוצג במסך העריכה.
* אחרי 10 ניסיונות שגויים ב-15 דקות הכניסה נחסמת זמנית.
* הלקוח יכול לאשר בלחיצה + שם מלא; הסטטוס משתנה ל"אושר" ואתה רואה את זה ברשימה.
* `/quotes/HM-2026-00XX` (הכתובת הישנה) מפנה אוטומטית ל-`/q/...`.

## הרצה מקומית (דקה)

```bash
npm install
cp .env.example .env        # ערוך: ADMIN_PASSWORD, SECRET, BASE_URL
node seed.js                # אופציונלי – הצעה לדוגמה HM-2026-0078 (טלפון 050-282-7733)
npm start                   # http://localhost:3000/admin
```

## העלאה לשרת (quote.neotechvision.io)

### אפשרות א – Railway / Render (הכי פשוט, בלי שרת משלך)
1. העלה את התיקייה ל-GitHub (ללא `data/` ו-`.env`).
2. צור שירות חדש מה-repo. פקודת הרצה: `npm start`.
3. הוסף **Volume** (דיסק קבוע) ומפה אותו ל-`/app/data` – שם נשמר מסד הנתונים.
4. משתני סביבה: `ADMIN_PASSWORD`, `SECRET` (מחרוזת אקראית ארוכה), `BASE_URL=https://quote.neotechvision.io`, `DATA_DIR=/app/data`.
5. ב-DNS של neotechvision.io: רשומת CNAME של `quote` לכתובת שהשירות נותן.

### אפשרות ב – Docker על VPS
```bash
docker build -t quotegen .
docker run -d --name quotegen -p 3000:3000 -v $PWD/data:/app/data \
  -e ADMIN_PASSWORD=... -e SECRET=... -e BASE_URL=https://quote.neotechvision.io quotegen
```
ומולו Nginx/Caddy עם HTTPS.

> הצעות ישנות שכבר נשלחו מהמערכת הקודמת לא עוברות אוטומטית – אם צריך, מזינים אותן מחדש במסך הניהול עם אותו מספר, והקישור הישן ימשיך לעבוד.

## התאמות
* **לוגו** – החלף את `public/logo.svg` (או הדבק כתובת בהגדרות).
* **תנאים / שלבים / פריסת תשלומים כברירת מחדל** – `defaults.js`. בכל הצעה אפשר לערוך בנפרד.
* **צבעים** – בראש `public/style.css` (`--maroon`, `--navy`).

## קבצים
```
server.js      נתיבים, שער הטלפון, ניהול
db.js          SQLite (quotes, views, approvals, settings)
defaults.js    ברירות מחדל: פרטי חברה, תנאים, שלבים, תשלומים
views/         gate.ejs (שער), quote.ejs (ההצעה), admin/*
public/        style.css, logo.svg
seed.js        הצעה לדוגמה
```
