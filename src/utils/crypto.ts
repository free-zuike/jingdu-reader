// 加密工具函数

import { SignJWT, jwtVerify } from 'jose';

const encoder = new TextEncoder();

// 生成UUID
export function generateUUID(): string {
  return crypto.randomUUID();
}

// 生成随机验证码
export function generateVerificationCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// 密码哈希（使用Web Crypto API）
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const passwordBuffer = encoder.encode(password);
  
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    passwordBuffer,
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  
  const hash = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100000,
      hash: 'SHA-256'
    },
    keyMaterial,
    256
  );
  
  const saltBase64 = btoa(String.fromCharCode(...salt));
  const hashBase64 = btoa(String.fromCharCode(...new Uint8Array(hash)));
  
  return `${saltBase64}:${hashBase64}`;
}

// 验证密码
export async function verifyPassword(password: string, hashedPassword: string): Promise<boolean> {
  const [saltBase64, hashBase64] = hashedPassword.split(':');
  
  const salt = Uint8Array.from(atob(saltBase64), c => c.charCodeAt(0));
  const passwordBuffer = encoder.encode(password);
  
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    passwordBuffer,
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  
  const hash = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100000,
      hash: 'SHA-256'
    },
    keyMaterial,
    256
  );
  
  const newHashBase64 = btoa(String.fromCharCode(...new Uint8Array(hash)));
  
  return newHashBase64 === hashBase64;
}

// 生成JWT Token
export async function generateToken(payload: { userId: string; email: string }, secret: string): Promise<string> {
  const secretKey = encoder.encode(secret);
  
  const token = await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(secretKey);
  
  return token;
}

// 验证JWT Token
export async function verifyToken(token: string, secret: string): Promise<{ userId: string; email: string } | null> {
  try {
    const secretKey = encoder.encode(secret);
    const { payload } = await jwtVerify(token, secretKey);
    
    return {
      userId: payload.userId as string,
      email: payload.email as string
    };
  } catch {
    return null;
  }
}

// AES加密
export async function encrypt(text: string, key: string): Promise<string> {
  const keyBuffer = encoder.encode(key.padEnd(32, '0').slice(0, 32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const textBuffer = encoder.encode(text);
  
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBuffer,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );
  
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    textBuffer
  );
  
  const ivBase64 = btoa(String.fromCharCode(...iv));
  const encryptedBase64 = btoa(String.fromCharCode(...new Uint8Array(encrypted)));
  
  return `${ivBase64}:${encryptedBase64}`;
}

// AES解密
export async function decrypt(encryptedText: string, key: string): Promise<string> {
  const keyBuffer = encoder.encode(key.padEnd(32, '0').slice(0, 32));
  const [ivBase64, encryptedBase64] = encryptedText.split(':');
  
  const iv = Uint8Array.from(atob(ivBase64), c => c.charCodeAt(0));
  const encrypted = Uint8Array.from(atob(encryptedBase64), c => c.charCodeAt(0));
  
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBuffer,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );
  
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    encrypted
  );
  
  return new TextDecoder().decode(decrypted);
}
