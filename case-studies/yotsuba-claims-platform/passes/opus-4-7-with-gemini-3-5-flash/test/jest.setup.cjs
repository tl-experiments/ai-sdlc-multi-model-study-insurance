/**
 * Jest setup file for testing.
 * This script runs before each test suite is executed.
 */

// Ensure NODE_ENV is set to 'test'
process.env.NODE_ENV = 'test';

// Set global test timeout (10 seconds)
jest.setTimeout(10000);