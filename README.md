# Student Hub

A student community website with:

- Microsoft account sign-in
- Microsoft account name used as the display name
- Education and Relaxation sections
- Persistent posts in Supabase
- Server-side moderation gate before publishing
- Reporting system
- Security rule: browsers cannot directly insert posts into the database

## IMPORTANT REALITY CHECK

Hosting the website can be free, but AI moderation is not automatically unlimited and free forever. This project intentionally uses a `MODERATION_WEBHOOK_URL` adapter so you can connect a moderation provider without exposing its secret key in the browser.

The moderation function **fails closed**: if moderation is unavailable, the post is NOT published.

AI should not be treated as perfect. For a student community, keep a human admin/review path and clear community rules.

## 1. Create a Supabase project

Create a project, then run `supabase/schema.sql` in the SQL editor.

Copy your:
- Project URL
- anon/public key

Paste them into `app.js`:

```js
const SUPABASE_URL = "PASTE_YOUR_SUPABASE_URL";
const SUPABASE_ANON_KEY = "PASTE_YOUR_SUPABASE_ANON_KEY";
```

## 2. Microsoft sign-in

In Supabase Authentication, configure the Azure/Microsoft provider.

You must also create/configure the Microsoft application registration and use the redirect URL Supabase gives you.

After Microsoft sign-in works, test that the returned account metadata contains the student's name. The website uses `full_name`, then `name`, as the display name.

### Privacy improvement recommended

If this is for one school, restrict sign-in to that school's Microsoft organization rather than allowing every Microsoft account.

## 3. Deploy the moderation function

Deploy:

```bash
supabase functions deploy moderate-post
```

Set secrets server-side:

```bash
supabase secrets set MODERATION_WEBHOOK_URL="https://YOUR-MODERATION-SERVER"
supabase secrets set MODERATION_WEBHOOK_TOKEN="YOUR_SECRET"
```

The moderation endpoint should accept:

```json
{ "title": "...", "content": "...", "section": "education" }
```

And return:

```json
{ "allowed": true, "reason": "...", "labels": ["school-friendly"] }
```

## 4. Continuous monitoring

No AI system can honestly guarantee it catches everything immediately. A stronger production design is:

1. Check every new post and edit before publishing.
2. Recheck reported posts immediately.
3. Run a scheduled server-side scan of existing published posts.
4. Automatically hide clear violations.
5. Send uncertain cases to an adult/admin reviewer.
6. Keep audit logs.

Do not rely on client-side moderation; users can bypass browser JavaScript.

## 5. Publish the website

For GitHub Pages:

1. Create a GitHub repository.
2. Upload `index.html`, `style.css`, and `app.js`.
3. Enable GitHub Pages in repository settings.

Your Supabase data is separate, so updating the website files does not erase posts or accounts.

## Before opening to students

- Get permission from the school/organization if this represents a school community.
- Publish clear community guidelines and a privacy notice.
- Avoid collecting unnecessary personal information.
- Have an adult/admin moderation process.
- Test authentication and database permissions with a non-admin account.
