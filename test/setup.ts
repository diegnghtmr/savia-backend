if (!process.env.SAVIA_CREDENTIAL_KEY)
  process.env.SAVIA_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString('base64');
