# FP Lounge

Static product/award media lounge for Vercel deployment.

## Files

- `index.html`: main page
- `admin.html`: local administrator upload page
- `app-config.js`: optional Supabase connection settings
- `supabase-schema.sql`: Supabase tables, storage bucket, and policies
- `vercel.json`: Vercel static hosting options

## Deploy

Import this repository in Vercel and use the default static site settings.

## Supabase

1. Create a Supabase project.
2. Run `supabase-schema.sql` in the Supabase SQL editor.
3. Copy the project URL and publishable key into `app-config.js`.
4. Commit and push `app-config.js`; Vercel will redeploy automatically.

When `app-config.js` is empty, the app falls back to browser local storage.
