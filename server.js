const express = require('express');
const fs = require('fs');
const path = require('path');

// This simple server implements X (Twitter) OAuth, a posting endpoint, and a status endpoint.
// In a real application you would store tokens securely and handle error cases.

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const TOKEN_STORE_PATH = path.join(__dirname, 'tokens.json');

const loadAccounts = () => {
  try {
    const raw = fs.readFileSync(TOKEN_STORE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('Failed to load token store', err);
    }
    return {};
  }
};

const persistAccounts = (accounts) => {
  try {
    fs.writeFileSync(TOKEN_STORE_PATH, JSON.stringify(accounts, null, 2));
  } catch (err) {
    console.error('Failed to persist token store', err);
  }
};

// Persistent store for connected Twitter accounts and their tokens
const accounts = loadAccounts();

const CLIENT_ID = process.env.TWITTER_CLIENT_ID;
const CLIENT_SECRET = process.env.TWITTER_CLIENT_SECRET;
const REDIRECT_URI = process.env.TWITTER_REDIRECT_URI;

if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
  throw new Error('TWITTER_CLIENT_ID, TWITTER_CLIENT_SECRET, and TWITTER_REDIRECT_URI must be set');
}

/**
 * Step 1: Initiate the OAuth flow by redirecting the user to X to grant access.
 * See https://developer.twitter.com/en/docs/authentication/oauth-2-0/authorization-code
 */
app.get('/api/auth/twitter', (req, res) => {
  const state = Math.random().toString(36).substring(2, 15);
  const scope = encodeURIComponent('tweet.read tweet.write users.read offline.access');
  const url = `https://twitter.com/i/oauth2/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${scope}&state=${state}&code_challenge=challenge&code_challenge_method=plain`;
  res.redirect(url);
});

/**
 * Step 2: OAuth callback where we exchange the authorization code for an access token and refresh token.
 * Note: This implementation uses fetch and assumes Node 18+. Replace with your preferred HTTP client if needed.
 */
app.get('/api/auth/twitter/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const params = new URLSearchParams();
    params.append('code', code);
    params.append('grant_type', 'authorization_code');
    params.append('client_id', CLIENT_ID);
    params.append('redirect_uri', REDIRECT_URI);
    params.append('code_verifier', 'challenge');
    const response = await fetch('https://api.x.com/2/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')
      },
      body: params
    });
    const data = await response.json();
    if (!response.ok) {
      console.error('OAuth response error', data);
      return res.status(response.status).send('OAuth failed');
    }
    console.log('Token response from X', {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in,
      expires_at: data.expires_in ? Date.now() + data.expires_in * 1000 : null
    });
    // Store tokens in persistent store under a default account key
    accounts.default = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in,
      scope: data.scope,
      token_type: data.token_type,
      received_at: Date.now(),
      expires_at: data.expires_in ? Date.now() + data.expires_in * 1000 : null
    };
    persistAccounts(accounts);
    res.send('Connected your X account successfully.');
  } catch (err) {
    console.error('OAuth error', err);
    res.status(500).send('OAuth failed');
  }
});

/**
 * POST /api/post
 * Publish a tweet on behalf of a connected account. Expects JSON with a `content` field
 * and optional `accountId` if multiple accounts are stored. Returns the URL of the posted tweet.
 */
app.post('/api/post', async (req, res) => {
  const { content, accountId } = req.body;
  const key = accountId || 'default';
  const account = accounts[key];
  if (!account || !account.access_token) {
    return res.status(400).json({ error: 'No access token found for this account' });
  }
  try {
    const tweetResp = await fetch('https://api.twitter.com/2/tweets', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${account.access_token}`
      },
      body: JSON.stringify({ text: content })
    });
    const result = await tweetResp.json();
    if (!tweetResp.ok) {
      console.error('Post tweet response error', result);
      return res.status(tweetResp.status).json({ error: 'Failed to post tweet' });
    }
    const tweetId = result.data?.id;
    const tweetUrl = tweetId ? `https://twitter.com/i/web/status/${tweetId}` : null;
    return res.json({ id: tweetId, url: tweetUrl });
  } catch (err) {
        
    
        
        

    
    console.error('Posting error', err);
    return res.status(500).json({ error: 'Failed to post tweet' });
  }
});

/**
 * GET /api/status
 * Return information about the connected account and recent posts. This endpoint fetches
 * the current user and their last 10 tweets including public metrics.
 */
app.get('/api/status', async (req, res) => {
  const account = accounts.default;
  if (!account || !account.access_token) {
    return res.status(400).json({ error: 'No connected account' });
  }
  try {
    // Fetch current user
    const userResp = await fetch('https://api.twitter.com/2/users/me', {
      headers: { 'Authorization': `Bearer ${account.access_token}` }
    });
    const userData = await userResp.json();
    const userId = userData.data?.id;
    // Fetch last 10 tweets with public metrics
    const tweetsResp = await fetch(`https://api.twitter.com/2/users/${userId}/tweets?max_results=10&tweet.fields=public_metrics`, {
      headers: { 'Authorization': `Bearer ${account.access_token}` }
    });
    const tweetsData = await tweetsResp.json();
    const tweets = tweetsData.data || [];
    const metrics = tweets.map(t => ({ id: t.id, metrics: t.public_metrics }));
    return res.json({
      account: userData.data,
      posts: tweets,
      metrics
    });
  } catch (err) {
    console.error('Status error', err);
    return res.status(500).json({ error: 'Failed to fetch status' });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
