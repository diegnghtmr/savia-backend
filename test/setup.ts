if (!process.env.SAVIA_CREDENTIAL_KEY)
  process.env.SAVIA_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString('base64');
if (!process.env.CLI_DEVICE_VERIFICATION_URI)
  process.env.CLI_DEVICE_VERIFICATION_URI = 'https://app.example.test/device';
