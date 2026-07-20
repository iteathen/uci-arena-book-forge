import { createHash } from 'node:crypto';
import { Chess } from 'chess.js';
import { castling, enPassant, piece, turn } from '@echecs/zobrist';

const pieceNames = {
  p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king',
};
const promotionCodes = { n: 1, b: 2, r: 3, q: 4 };

function parseFen(fen) {
  const fields = String(fen).trim().split(/\s+/);
  if (fields.length < 4) throw new Error(`Invalid FEN: ${fen}`);
  return fields;
}

function epIsCapturable(placement, side, epSquare) {
  if (epSquare === '-') return false;
  const file = epSquare.charCodeAt(0) - 97;
  const rank = Number(epSquare[1]);
  if (file < 0 || file > 7 || !Number.isInteger(rank)) return false;
  const pawnRank = side === 'w' ? rank - 1 : rank + 1;
  if (pawnRank < 1 || pawnRank > 8) return false;
  const board = placementToMap(placement);
  const pawn = side === 'w' ? 'P' : 'p';
  return [-1, 1].some((delta) => board.get(`${String.fromCharCode(97 + file + delta)}${pawnRank}`) === pawn);
}

function placementToMap(placement) {
  const board = new Map();
  const ranks = placement.split('/');
  if (ranks.length !== 8) throw new Error(`Invalid FEN placement: ${placement}`);
  for (let row = 0; row < 8; row += 1) {
    let file = 0;
    for (const token of ranks[row]) {
      if (/\d/.test(token)) {
        file += Number(token);
      } else {
        if (file > 7 || !pieceNames[token.toLowerCase()]) throw new Error(`Invalid FEN placement: ${placement}`);
        board.set(`${String.fromCharCode(97 + file)}${8 - row}`, token);
        file += 1;
      }
    }
    if (file !== 8) throw new Error(`Invalid FEN placement: ${placement}`);
  }
  return board;
}

export function canonicalFen(fen) {
  const [placement, side, castlingRights, ep] = parseFen(fen);
  if (side !== 'w' && side !== 'b') throw new Error(`Invalid FEN side: ${side}`);
  placementToMap(placement);
  if (castlingRights !== '-' && !/^[KQkq]+$/.test(castlingRights)) throw new Error(`Invalid FEN castling rights: ${castlingRights}`);
  const canonicalRights = [...'KQkq'].filter((right) => castlingRights.includes(right)).join('') || '-';
  const canonicalEp = epIsCapturable(placement, side, ep) ? ep : '-';
  return `${placement} ${side} ${canonicalRights} ${canonicalEp} 0 1`;
}

export function polyglotKey(fen) {
  const [placement, side, rights, ep] = parseFen(canonicalFen(fen));
  let key = 0n;
  for (const [square, token] of placementToMap(placement)) {
    const color = token === token.toUpperCase() ? 'white' : 'black';
    key ^= piece(square, pieceNames[token.toLowerCase()], color);
  }
  if (rights.includes('K')) key ^= castling('white', 'king');
  if (rights.includes('Q')) key ^= castling('white', 'queen');
  if (rights.includes('k')) key ^= castling('black', 'king');
  if (rights.includes('q')) key ^= castling('black', 'queen');
  if (ep !== '-') key ^= enPassant(ep[0]);
  if (side === 'w') key ^= turn('white');
  return key;
}

export function keyBuffer(key) {
  const buffer = Buffer.allocUnsafe(8);
  buffer.writeBigUInt64BE(BigInt.asUintN(64, key));
  return buffer;
}

export function keyHex(key) {
  return BigInt.asUintN(64, key).toString(16).padStart(16, '0');
}

export function positionFingerprint(fen) {
  return createHash('sha256').update(canonicalFen(fen), 'utf8').digest().subarray(0, 16);
}

function squareIndex(square) {
  if (!/^[a-h][1-8]$/.test(square)) throw new Error(`Invalid square: ${square}`);
  return (Number(square[1]) - 1) * 8 + square.charCodeAt(0) - 97;
}

export function encodePolyglotMove(uci) {
  if (!/^[a-h][1-8][a-h][1-8][nbrq]?$/.test(uci)) throw new Error(`Invalid UCI move: ${uci}`);
  let from = uci.slice(0, 2);
  let to = uci.slice(2, 4);
  if (from === 'e1' && to === 'g1') to = 'h1';
  else if (from === 'e1' && to === 'c1') to = 'a1';
  else if (from === 'e8' && to === 'g8') to = 'h8';
  else if (from === 'e8' && to === 'c8') to = 'a8';
  const fromIndex = squareIndex(from);
  const toIndex = squareIndex(to);
  const promotion = promotionCodes[uci[4]] ?? 0;
  return (promotion << 12) | ((fromIndex >> 3) << 9) | ((fromIndex & 7) << 6) |
    ((toIndex >> 3) << 3) | (toIndex & 7);
}

export function moveHex(rawMove) {
  return Number(rawMove).toString(16).padStart(4, '0');
}

export function legalUciMove(fen, uci) {
  const chess = new Chess(canonicalFen(fen));
  try {
    return Boolean(chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }));
  } catch {
    return false;
  }
}

export function uciFromVerboseMove(move) {
  return `${move.from}${move.to}${move.promotion ?? ''}`;
}

export function shardForKey(key) {
  return Number(BigInt.asUintN(64, key) >> 58n);
}
