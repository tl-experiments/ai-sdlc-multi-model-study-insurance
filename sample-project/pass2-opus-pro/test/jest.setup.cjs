process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "file:./test.db";
process.env.JWT_SECRET = "test-jwt-secret-please-rotate";
process.env.KEK_HEX = "0".repeat(64);
