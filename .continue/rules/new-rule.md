- Email Transaction Monitor Agent Rules

1. Core Objective
   Maintain the production stability of the Node.js server that monitors user emails for financial transactions, categorizes them, and sends push notifications. Priority is preserving the Gmail Watch subscription state and preventing the service from stopping due to token expiration or transient API failures.

2. Critical Logic Constraints
   Token Expiration Handling (HIGH PRIORITY)
   Automatic Refresh: When a token expiration error (invalid_grant, Request had invalid authentication credentials) is detected:
   DO NOT immediately delete the user's token or stop the client.
   IMMEDIATELY attempt a silent refresh using the stored refresh_token from the oauth_tokens table in Supabase.
   If refresh succeeds:
   Update the oauth_tokens table in Supabase with the new access_token and refresh_token.
   Re-register the OAuth client for that user in the clients map (clients.set(userID, newAuth)).
   DO NOT send a notification about token expiration if the refresh succeeded.
   If refresh fails:
   Delete the invalid token from the database.
   Remove the client from the clients map.
   Send a high-priority notification: "Token Refresh Failed - Please reauthenticate manually."
   Email Processing Flow
   Regex Matching: Strictly adhere to the existing regex patterns for:
   NETS, OCBC Paynow, OCBC CC
   DBS Paynow
   HSBC
   SC CC
   If no pattern matches, the email is NOT a transaction and should be logged as generic "Info: Email received but no transaction pattern matched".
   AI Categorization:
   Only call the Gemini AI function detectCategoryUsingAI if a transaction amount and description are successfully extracted.
   Ensure the input description sent to the AI is clean (trimmed of excessive whitespace).
   Database Logging:
   Always call add-expense (Supabase function) after a successful transaction detection and categorization, regardless of the notification status (to ensure database consistency).
   Pub/Sub & Watch Subscription
   Never close or delete a Pub/Sub subscription for a user unless they explicitly revoke access in Google.
   Re-initializing the OAuth client (via getOAuthClient) is required to reset the watch subscription state when a token is refreshed.
3. Error Handling & Logging
   Logging: Log all transaction detections with timestamp, amount, description, and detected category.
   Error Classification:
   Token Errors: Treat as refreshable.
   Generic API Errors (e.g., network timeout, 503): Log and retry the current operation if possible; do not delete user data.
   Invalid Email: If the email body is empty or malformed, log "Malformed email body" and skip processing.
   Transaction Alerts: Only send push notifications if:
   A transaction was confirmed.
   The user has a valid push subscription (check push_subscriptions table).
   The user is not currently in a "Token Refresh" state (avoid notification spam during re-auth flows).
4. Database Schema Adherence
   Tables to Access:
   oauth_tokens (user_id, access_token, refresh_token, expires_at, etc.)
   push_subscriptions (user_id, endpoint, keys)
   user_categories (user_id, category_name, category_icon)
   expenses (amount, description, category_id, user_id, etc.)
   Supabase Functions:
   detectCategoryUsingAI: Input must include { description: string, category_names: string[] }.
   add-expense: Call this with the final determined category and data.
   Security:
   Never expose GOOGLE_CLIENT_SECRET or GOOGLE_CLIENT_ID in logs. Use placeholders like [CLIENT_ID].
   Ensure all Supabase queries include user_id for authorization.
5. File Modification Guidelines
   Files to Modify:
   server.js: Primary server logic, OAuth handling, and error catching.
   utils/transactionParser.js (or similar): Regex patterns.
   utils/aiCategorizer.js: AI logic.
   database/schema.sql: If schema changes are needed for token refresh.
   Forbidden Changes:
   Do not change the external API endpoints (Google Gmail, Supabase, Web Push).
   Do not change the core regex patterns unless explicitly asked to add a new bank pattern (e.g., MASTERCARD, AMERICAN_EXPRESS).
   Do not remove the existing fallback notification logic; it is only a fallback to the silent refresh.
6. Current State Awareness
   If a user has just re-authenticated, the system should NOT send a generic "New Transaction" notification for the very first email processed with the new token unless it actually contains a transaction.
   Keep track of last_history_id per user in the oauth_tokens table to avoid re-processing historical emails. Do not attempt to fetch emails older than the last known history ID.
7. Special Instructions for Token Refresh
   Scenario: User receives "Token Expired" error in logs.
   Action:
   Query oauth_tokens for the user.
   Call google.auth.OAuth2.refreshToken(token.refresh_token).
   If success:
   Write new tokens to Supabase.
   clients.set(userId, newClient).
   Stop (do not proceed to delete token).
   If fail:
   Proceed to delete token and notify user.
8. Testing & Validation
   Mock Test: Simulate a token expiration error by modifying the mock response in the test suite to include invalid_grant. Verify that refreshTokenSilently executes and updates the DB.
   Verification: After a token refresh, verify that new emails are still being fetched correctly via the Pub/Sub listener.
