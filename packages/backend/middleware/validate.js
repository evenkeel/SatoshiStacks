/**
 * Input validation middleware — lightweight, no external dependencies.
 * Validates request bodies/params before they reach route handlers.
 */

/**
 * Create an Express middleware that validates req.body against a schema.
 * Schema format: { fieldName: { type, required?, min?, max?, maxLength?, pattern? } }
 */
function validateBody(schema) {
  return (req, res, next) => {
    const errors = [];
    const body = req.body || {};

    for (const [field, rules] of Object.entries(schema)) {
      const value = body[field];

      // Required check
      if (rules.required && (value === undefined || value === null || value === '')) {
        errors.push(`${field} is required`);
        continue;
      }

      // Skip optional fields that are absent
      if (value === undefined || value === null) continue;

      // Type check
      if (rules.type === 'string' && typeof value !== 'string') {
        errors.push(`${field} must be a string`);
      } else if (rules.type === 'number' && typeof value !== 'number') {
        errors.push(`${field} must be a number`);
      } else if (rules.type === 'boolean' && typeof value !== 'boolean') {
        errors.push(`${field} must be a boolean`);
      } else if (rules.type === 'object' && (typeof value !== 'object' || Array.isArray(value))) {
        errors.push(`${field} must be an object`);
      }

      // String constraints
      if (rules.type === 'string' && typeof value === 'string') {
        if (rules.maxLength && value.length > rules.maxLength) {
          errors.push(`${field} must be at most ${rules.maxLength} characters`);
        }
        if (rules.pattern && !rules.pattern.test(value)) {
          errors.push(`${field} has invalid format`);
        }
      }

      // Number constraints
      if (rules.type === 'number' && typeof value === 'number') {
        if (rules.min !== undefined && value < rules.min) {
          errors.push(`${field} must be at least ${rules.min}`);
        }
        if (rules.max !== undefined && value > rules.max) {
          errors.push(`${field} must be at most ${rules.max}`);
        }
        if (rules.integer && !Number.isInteger(value)) {
          errors.push(`${field} must be an integer`);
        }
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({ success: false, errors });
    }

    next();
  };
}

// ==================== SCHEMAS ====================

const schemas = {
  adminBan: {
    userId: { type: 'string', required: true, maxLength: 128 },
    reason: { type: 'string', required: true, maxLength: 500 },
    banIp: { type: 'boolean' }
  },

  adminUnban: {
    userId: { type: 'string', required: true, maxLength: 128 }
  },

  adminBanIp: {
    ipAddress: { type: 'string', required: true, maxLength: 45 },  // IPv6 max length
    reason: { type: 'string', required: true, maxLength: 500 }
  },

  adminUnbanIp: {
    ipAddress: { type: 'string', required: true, maxLength: 45 }
  },

  authVerify: {
    challengeId: { type: 'string', required: true, maxLength: 128 },
    signedEvent: { type: 'object', required: true }
  }
};

module.exports = { validateBody, schemas };
