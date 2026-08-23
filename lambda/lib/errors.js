'use strict';

// Small error type carrying an HTTP status, mirrored from the reference project.
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

module.exports = { ApiError };
