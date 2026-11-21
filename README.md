# Student Hub

Student Hub is a student community website with two main spaces:

- **Education** — school projects, learning, and ideas.
- **Relaxation** — school-friendly conversations and shared interests.

The site uses **Supabase email/password authentication**. Students choose a display name when they create an account.

## Current features

- Email/password sign-up and sign-in
- Student profiles with display names, short bios, and optional profile pictures
- Education and Relaxation post feeds
- Optional image attachments on posts (JPG, PNG, or WebP; maximum 5 MB)
- Server-side moderation before a post is published
- Staff review queue for posts that need a human decision
- Post likes, comments, and reports
- Notifications
- Private one-to-one and group messaging with request/accept flows
- Blocking and reporting for private messages
- Community points and leaderboard
- Staff roles and moderation tools for posts and members

## Project structure

- `index.html` — page structure and interface
- `style.css` — layout and visual styling
- `app.js` — Supabase client, authentication, feeds, and interactive features
- `supabase/functions/moderate-post/index.ts` — server-side post moderation function
- `supabase/` — database setup and related Supabase project files

## Supabase configuration

The browser app is configured in `app.js`:

```js
const SUPABASE_URL = "YOUR_SUPABASE_PROJECT_URL";
const SUPABASE_ANON_KEY = "YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY";
```

Only the publishable/anon key belongs in browser code. **Never put a Supabase service-role key or an OpenAI secret key in `app.js`, HTML, CSS, or any other public GitHub Pages file.**

Configure Supabase Authentication for email/password sign-in. The sign-up flow stores the student's chosen display name in user metadata.

## Post image storage

Create a Supabase Storage bucket named exactly:

```
post_images
```

The current frontend expects the bucket to:

- Be public so published post images can be displayed with public URLs.
- Allow JPEG, PNG, and WebP images.
- Enforce a 5 MB file-size limit.

The upload policy should allow authenticated users to upload only into a folder named with their own authenticated user ID. The intended object path is:

```
USER_ID/IMAGE_UUID.jpg
```

Use the authenticated user's ID in place of `USER_ID`. Do not create a broad authenticated upload policy that lets users write into other users' folders.

The `posts` table needs an `image_path` text column that can be null. The browser stores the Storage object path in that column; it does not store the image bytes in the database.

## Post moderation function

Post submissions are sent to a Supabase Edge Function. The function must validate the signed-in user, check applicable account restrictions, moderate the post text and optional image on the server, and only then insert the post.

The function's deployed name must match the function name used by `supabase.functions.invoke(...)` in `app.js`. The source folder name and deployed function name should be kept consistent when deploying.

Required server-side secrets depend on the current function implementation. For the current moderation implementation, configure these in Supabase Edge Function secrets:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAI_API_KEY`

Keep all secret values in Supabase, never in the public repository. Deploying a code change to GitHub does **not** deploy the Edge Function to Supabase; deploy the function separately after changing its source.

The moderation flow should fail closed: if moderation is unavailable or returns an error, the post should not be published.

## Roles and moderation

The site recognizes these staff roles:

- **Owner**
- **Admin**
- **Moderator**

The browser uses role information to show the appropriate staff interface, but database permissions and security-definer RPC functions must enforce every privileged action. Hiding a button in the browser is not a security boundary.

Staff tools include reviewing flagged posts, handling reports, hiding/restoring posts, and managing member roles or account restrictions according to role permissions.

## Publishing with GitHub Pages

The public website is served from GitHub Pages. Changes to `index.html`, `style.css`, `app.js`, and other site files on the published branch are deployed by GitHub Pages after its build/update completes.

Supabase is separate from GitHub Pages:

- GitHub Pages serves the website.
- Supabase Authentication manages accounts.
- Supabase Database stores community data.
- Supabase Storage stores post images.
- Supabase Edge Functions run server-side moderation and other protected logic.

## Before inviting students

- Get approval from the school or organization if the site represents it.
- Publish clear community guidelines and a privacy notice.
- Avoid collecting unnecessary personal information.
- Have a responsible adult/staff moderation process.
- Test the site with a regular student account as well as staff accounts.
- Review Supabase Row Level Security (RLS) policies and Storage policies; never rely on frontend checks alone.
