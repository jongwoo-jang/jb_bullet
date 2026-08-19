# FP Lounge

Static product/award media lounge for Vercel deployment. Heavy files can be stored in Google Drive while Supabase stores only searchable post metadata.

## Files

- `index.html`: main page
- `admin.html`: local administrator upload page
- `app-config.js`: optional Supabase connection settings
- `api/config.js`: public runtime config for Supabase login
- `api/_auth.js`: server-side Supabase session and admin email verification
- `api/admin/upload.js`: Vercel Function that uploads files to Google Drive and writes metadata to Supabase
- `api/admin/delete.js`: Vercel Function that deletes Google Drive files and Supabase posts
- `supabase-schema.sql`: Supabase tables and RLS policies
- `vercel.json`: Vercel static hosting options

## Deploy

Import this repository in Vercel and use the default static site settings.

## Supabase and Google Drive

1. Create a Supabase project.
2. Run `supabase-schema.sql` in the Supabase SQL editor.
3. Enable Supabase Auth email login and set the site URL to `https://jb-bullet.vercel.app`.
4. Add the project URL and publishable key to Vercel env vars so the public feed can log in and read posts.
5. Create a Google Cloud service account, enable the Google Drive API, and share the target Drive folder with the service account email.
6. Add these Vercel Environment Variables for Production, Preview, and Development:

```text
SUPABASE_URL
SUPABASE_PUBLISHABLE_KEY
SUPABASE_SERVICE_ROLE_KEY
GOOGLE_CLIENT_EMAIL
GOOGLE_PRIVATE_KEY
GOOGLE_DRIVE_FOLDER_ID
ADMIN_EMAILS
MAX_UPLOAD_BYTES
```

`GOOGLE_PRIVATE_KEY` should keep its newline escapes as `\n` when pasted into Vercel.

`ADMIN_EMAILS` is a comma-separated allowlist, for example `admin@example.com,manager@example.com`.

7. Deploy to Vercel, sign in with a Supabase user whose email is listed in `ADMIN_EMAILS`, and upload posts from `/admin`.

When `app-config.js` is empty, the app reads public Supabase config from `/api/config`. If both are empty, it falls back to browser local storage.

## Local Development

Install dependencies and run Vercel locally:

```bash
npm install
vercel env pull .env.local
vercel dev
```
