# FP Lounge

Static product/award media lounge for Vercel deployment. Heavy files can be stored in Google Drive while Supabase stores only searchable post metadata.

## Files

- `index.html`: main page
- `admin.html`: local administrator upload page
- `app-config.js`: optional Supabase connection settings
- `api/admin/upload.js`: Vercel Function that uploads files to Google Drive and writes metadata to Supabase
- `api/admin/delete.js`: Vercel Function that deletes Google Drive files and Supabase posts
- `supabase-schema.sql`: Supabase tables and RLS policies
- `vercel.json`: Vercel static hosting options

## Deploy

Import this repository in Vercel and use the default static site settings.

## Supabase and Google Drive

1. Create a Supabase project.
2. Run `supabase-schema.sql` in the Supabase SQL editor.
3. Copy the project URL and publishable key into `app-config.js` so the public feed can read posts.
4. Create a Google Cloud service account, enable the Google Drive API, and share the target Drive folder with the service account email.
5. Add these Vercel Environment Variables for Production, Preview, and Development:

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
GOOGLE_CLIENT_EMAIL
GOOGLE_PRIVATE_KEY
GOOGLE_DRIVE_FOLDER_ID
ADMIN_UPLOAD_TOKEN
MAX_UPLOAD_BYTES
```

`GOOGLE_PRIVATE_KEY` should keep its newline escapes as `\n` when pasted into Vercel.

6. Deploy to Vercel, open `/admin`, enter the same value as `ADMIN_UPLOAD_TOKEN`, and upload posts.

When `app-config.js` is empty, the app falls back to browser local storage.

## Local Development

Install dependencies and run Vercel locally:

```bash
npm install
vercel env pull .env.local
vercel dev
```
