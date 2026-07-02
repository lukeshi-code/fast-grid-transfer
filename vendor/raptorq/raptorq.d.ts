/* tslint:disable */
/* eslint-disable */
/**
*/
export class Decoder {
  free(): void;
/**
* @param {bigint} transfer_length
* @param {number} maximum_transmission_unit
* @returns {Decoder}
*/
  static with_defaults(transfer_length: bigint, maximum_transmission_unit: number): Decoder;
/**
* @param {Uint8Array} packet
* @returns {Uint8Array | undefined}
*/
  decode(packet: Uint8Array): Uint8Array | undefined;
/**
* @param {Uint8Array} packet
* @returns {Uint8Array | undefined}
*/
  add(packet: Uint8Array): Uint8Array | undefined;
}
/**
*/
export class Encoder {
  free(): void;
/**
* @param {Uint8Array} data
* @param {number} maximum_transmission_unit
* @returns {Encoder}
*/
  static with_defaults(data: Uint8Array, maximum_transmission_unit: number): Encoder;
/**
* @param {number} repair_packets_per_block
* @returns {(Uint8Array)[]}
*/
  encode(repair_packets_per_block: number): (Uint8Array)[];
/**
* @param {number} repair_packets_per_block
* @returns {(Uint8Array)[]}
*/
  encode_with_packet_size(repair_packets_per_block: number): (Uint8Array)[];
}
/**
*/
export class EncodingPacket {
  free(): void;
/**
* @param {Uint8Array} data
* @returns {EncodingPacket}
*/
  static deserialize(data: Uint8Array): EncodingPacket;
/**
* @returns {number}
*/
  source_block_number(): number;
/**
* @returns {number}
*/
  encoding_symbol_id(): number;
/**
* @returns {Uint8Array}
*/
  data(): Uint8Array;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_decoder_free: (a: number) => void;
  readonly decoder_with_defaults: (a: number, b: number) => number;
  readonly decoder_decode: (a: number, b: number, c: number, d: number) => void;
  readonly decoder_add: (a: number, b: number, c: number, d: number) => void;
  readonly __wbg_encoder_free: (a: number) => void;
  readonly encoder_with_defaults: (a: number, b: number, c: number) => number;
  readonly encoder_encode: (a: number, b: number, c: number) => void;
  readonly encoder_encode_with_packet_size: (a: number, b: number, c: number) => void;
  readonly __wbg_encodingpacket_free: (a: number) => void;
  readonly encodingpacket_deserialize: (a: number, b: number) => number;
  readonly encodingpacket_source_block_number: (a: number) => number;
  readonly encodingpacket_encoding_symbol_id: (a: number) => number;
  readonly encodingpacket_data: (a: number) => number;
  readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
  readonly __wbindgen_malloc: (a: number) => number;
  readonly __wbindgen_free: (a: number, b: number) => void;
  readonly __wbindgen_realloc: (a: number, b: number, c: number) => number;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {SyncInitInput} module
*
* @returns {InitOutput}
*/
export function initSync(module: SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {InitInput | Promise<InitInput>} module_or_path
*
* @returns {Promise<InitOutput>}
*/
export default function init (module_or_path?: InitInput | Promise<InitInput>): Promise<InitOutput>;
