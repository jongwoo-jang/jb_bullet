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
4. Create viewer and admin users in Supabase Authentication. Users sign in with their email address as the ID.
5. Add admin user emails to `ADMIN_EMAILS`; only those accounts can use `/admin`.
6. Add the project URL and publishable key to Vercel env vars so the public feed can log in and read posts.
7. Enable the Google Drive API in Google Cloud.
8. For a personal Google Drive folder, use Google OAuth credentials so uploads use your Google account storage quota.
9. Add these Vercel Environment Variables for Production, Preview, and Development:

```text
SUPABASE_URL
SUPABASE_PUBLISHABLE_KEY
SUPABASE_SERVICE_ROLE_KEY
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REFRESH_TOKEN
GOOGLE_CLIENT_EMAIL
GOOGLE_PRIVATE_KEY
GOOGLE_DRIVE_FOLDER_ID
ADMIN_EMAILS
MAX_UPLOAD_BYTES
```

The app prefers `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REFRESH_TOKEN` when they are present. `GOOGLE_CLIENT_EMAIL` and `GOOGLE_PRIVATE_KEY` are kept as a service-account fallback, mainly for Google Workspace shared drives.

`GOOGLE_PRIVATE_KEY` should keep its newline escapes as `\n` when pasted into Vercel.

`ADMIN_EMAILS` is a comma-separated allowlist, for example `admin@example.com,manager@example.com`.

10. Deploy to Vercel, sign in with a Supabase user whose email is listed in `ADMIN_EMAILS`, and upload posts from `/admin`.

The public login screen does not expose self-signup. Create accounts from Supabase Authentication and send each user their email ID and temporary password. Users can request a password reset from the login screen.

After deployment, open `/api/env-check` to confirm the required variables are present and `/api/drive-check` to confirm the Drive folder is writable. The `authMode` value should be `oauth` for personal Google Drive uploads.

When `app-config.js` is empty, the app reads public Supabase config from `/api/config`. If both are empty, it falls back to browser local storage.

## Local Development

Install dependencies and run Vercel locally:

```bash
npm install
vercel env pull .env.local
vercel dev
```
