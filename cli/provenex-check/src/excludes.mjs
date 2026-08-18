function escapeRegex(character) {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
}

function compileGlob(pattern) {
  let expression = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          expression += '(?:.*/)?';
          index += 2;
        } else {
          expression += '.*';
          index += 1;
        }
      } else {
        expression += '[^/]*';
      }
    } else if (character === '?') {
      expression += '[^/]';
    } else {
      expression += escapeRegex(character);
    }
  }
  return new RegExp(`^${expression}$`, 'u');
}

function compilePattern(rawPattern) {
  const pattern = rawPattern.endsWith('/') ? rawPattern.slice(0, -1) : rawPattern;
  const hasGlob = pattern.includes('*') || pattern.includes('?');
  const hasSlash = pattern.includes('/');
  if (!hasGlob) {
    return (relativePath) => {
      if (hasSlash) return relativePath === pattern || relativePath.startsWith(`${pattern}/`);
      return relativePath.split('/').some((part) => part === pattern);
    };
  }

  const matcher = compileGlob(pattern);
  const directoryPrefix = pattern.endsWith('/**') ? compileGlob(pattern.slice(0, -3)) : null;
  return (relativePath) => {
    if (directoryPrefix?.test(relativePath)) return true;
    if (hasSlash) return matcher.test(relativePath);
    return relativePath.split('/').some((part) => matcher.test(part));
  };
}

export function createExcludeMatcher(patterns) {
  const matchers = patterns.map(compilePattern);
  return (relativePath) => matchers.some((matcher) => matcher(relativePath));
}
