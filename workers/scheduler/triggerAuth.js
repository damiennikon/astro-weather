const encoder = new TextEncoder()

// Compare the whole candidate and expected value without returning early on the
// first differing byte. The length is included in the accumulated difference so
// a missing or truncated secret cannot authenticate.
export function constantTimeEqual(leftValue, rightValue) {
  if (typeof leftValue !== 'string' || typeof rightValue !== 'string') return false

  const left = encoder.encode(leftValue)
  const right = encoder.encode(rightValue)
  const length = Math.max(left.length, right.length)
  let difference = left.length ^ right.length

  for (let index = 0; index < length; index++) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }

  return difference === 0
}

export function isAuthorizedTrigger(request, expectedSecret) {
  const authorization = request.headers.get('Authorization') ?? ''
  const prefix = 'Bearer '
  if (!authorization.startsWith(prefix)) return false

  return constantTimeEqual(authorization.slice(prefix.length), expectedSecret)
}
