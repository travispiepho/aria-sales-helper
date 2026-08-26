export function normalizeMeetingTitle(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    const error = new Error('Meeting title cannot be empty');
    error.statusCode = 400;
    throw error;
  }
  return value.trim();
}

export function requireSingleMeetingUpdate(result) {
  if (result?.rowCount !== 1 || !result.rows?.[0]) {
    const error = new Error('Meeting changed before it could be updated. Reload and try again.');
    error.statusCode = 409;
    throw error;
  }
  return result.rows[0];
}
