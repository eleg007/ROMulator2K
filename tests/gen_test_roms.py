#!/usr/bin/env python3
"""Generate original test ROMs for ROMulator2K's four console systems.

Everything in this file is authored here from scratch — these are minimal
homebrew test images (solid-colour backdrop that flips colour while a
button is held), not derived from any copyrighted ROM.

Outputs (tests/roms/):
  test.nes  — iNES NROM-128           : blue backdrop -> red while A held
  test.gb   — Game Boy DMG, 32KB      : black backdrop -> white while A held
  test.sfc  — SNES LoROM, 32KB        : blue backdrop -> red while B held
  test.md   — Genesis/Mega Drive, 32KB : blue backdrop -> red while A held

Encodings verified against GNU as (binutils-m68k-linux-gnu):
  * m68k byte immediates are right-justified in the extension word
  * branch displacement base = instruction address + 2 (all widths)
"""
import struct
from pathlib import Path

OUT = Path(__file__).parent / "roms"


# ──────────────────────────────────────────────────────────────
# Mini assemblers (labels + branch fixups)
# ──────────────────────────────────────────────────────────────
class Asm:
    """Byte emitter with labels. Call resolve() before reading .out.

    Fixup kinds:
      rel8   — 6502/SM83 8-bit branch; placeholder 1 byte;
               disp = target - (instr_addr + 2)
      abs16  — 6502 absolute address; placeholder 2 bytes (LE)
    """

    def __init__(self, base=0):
        self.base = base
        self.out = bytearray()
        self.labels = {}
        self.fixups = []  # (placeholder_offset, label, kind, instr_addr)

    @property
    def here(self):
        return self.base + len(self.out)

    def label(self, name):
        self.labels[name] = self.here

    def db(self, *bs):
        for b in bs:
            if not 0 <= b <= 255:
                raise ValueError(f"byte out of range: {b}")
            self.out.append(b)

    def _fix(self, label, kind):
        # called immediately after the opcode byte(s), before placeholders
        self.fixups.append((len(self.out), label, kind, self.here))

    def resolve(self):
        for off, label, kind, addr in self.fixups:
            if label not in self.labels:
                raise KeyError(f"undefined label: {label}")
            target = self.labels[label]
            if kind == "rel8":
                # addr == instr_addr + 1 (opcode emitted, placeholder next)
                disp = target - (addr + 1)
                if not -128 <= disp <= 127:
                    raise ValueError(f"rel8 out of range ({disp:+d}) to {label}")
                self.out[off] = disp & 0xFF
            elif kind == "abs16":
                struct.pack_into("<H", self.out, off, target & 0xFFFF)
            else:
                raise ValueError(kind)
        self.fixups = []


class Asm68K(Asm):
    """8-bit Bcc/BRA: opcode byte + rel8, disp = target - (instr + 2)."""

    def resolve(self):
        for off, label, kind, addr in self.fixups:
            if label not in self.labels:
                raise KeyError(f"undefined label: {label}")
            if kind != "rel8":
                raise ValueError(kind)
            disp = self.labels[label] - (addr + 1)  # addr = instr + 1
            if not -128 <= disp <= 127:
                raise ValueError(f"bcc8 out of range ({disp:+d}) to {label}")
            self.out[off] = disp & 0xFF
        self.fixups = []


# ──────────────────────────────────────────────────────────────
# NES (6502) — iNES NROM-128
# ──────────────────────────────────────────────────────────────
def gen_nes() -> bytes:
    a = Asm(base=0xC000)   # 16KB PRG bank mapped at $C000-$FFFF

    def branch(op, label):
        a.db(op); a._fix(label, "rel8"); a.db(0)

    def jmp(label):
        a.db(0x4C); a._fix(label, "abs16"); a.db(0, 0)

    a.label("reset")
    a.db(0x78)                       # sei
    a.db(0xD8)                       # cld
    a.db(0xA2, 0x00, 0x9A)           # ldx #$00 / txs
    a.label("w1")
    a.db(0x2C, 0x02, 0x20)           # bit $2002 (PPUSTATUS)
    branch(0x10, "w1")               # bpl w1
    a.label("w2")
    a.db(0x2C, 0x02, 0x20)
    branch(0x10, "w2")               # two vblank waits = PPU warm-up
    a.db(0xA9, 0x3F, 0x8D, 0x06, 0x20)   # PPUADDR = $3F00
    a.db(0xA9, 0x00, 0x8D, 0x06, 0x20)
    a.db(0xA9, 0x21, 0x8D, 0x07, 0x20)   # backdrop = blue
    a.db(0xA9, 0x0A, 0x8D, 0x01, 0x20)   # $2001 = show BG (+left column)
    a.label("loop")
    a.db(0x2C, 0x02, 0x20)               # bit $2002
    branch(0x10, "loop")                 # wait for vblank
    a.db(0xA9, 0x01, 0x8D, 0x16, 0x40)   # controller strobe
    a.db(0xA9, 0x00, 0x8D, 0x16, 0x40)
    a.db(0xA2, 0x08)                     # ldx #$08
    a.label("read")
    a.db(0xAD, 0x16, 0x40)               # lda $4016
    a.db(0x4A)                           # lsr A (serial bit -> carry)
    a.db(0x06, 0x00)                     # rol $00
    a.db(0xCA)                           # dex
    branch(0xD0, "read")                 # bne read
    # after 8 rols the first button (A) sits in bit 7
    a.db(0xA5, 0x00, 0x29, 0x80)         # lda $00 / and #$80
    branch(0xF0, "notA")                 # beq notA
    a.db(0xA9, 0x16)                     # lda #$16 (red)
    jmp("write")
    a.label("notA")
    a.db(0xA9, 0x21)                     # lda #$21 (blue)
    a.label("write")
    a.db(0x48)                           # pha
    a.db(0xA9, 0x3F, 0x8D, 0x06, 0x20)   # PPUADDR = $3F00
    a.db(0xA9, 0x00, 0x8D, 0x06, 0x20)
    a.db(0x68)                           # pla
    a.db(0x8D, 0x07, 0x20)               # sta $2007
    jmp("loop")

    a.label("nmi"); a.db(0x40)           # rti (NMI stays disabled)
    a.label("irq"); a.db(0x40)           # rti
    a.resolve()

    prg = bytearray(a.out)
    prg += b"\x00" * (0x4000 - len(prg))
    struct.pack_into("<HHH", prg, 0x3FFA,
                     a.labels["nmi"], a.labels["reset"], a.labels["irq"])
    header = bytes(b"NES\x1a\x01\x01" + b"\x00" * 10)  # mapper 0, 16K PRG, 8K CHR
    return bytes(header) + bytes(prg) + b"\x00" * 0x2000  # CHR: transparent tiles


# ──────────────────────────────────────────────────────────────
# Game Boy (SM83)
# ──────────────────────────────────────────────────────────────
GB_LOGO = bytes.fromhex(
    "CEED6666CC0D000B03730083000C000D"
    "0008111F8889000EDCCC6EE6DDDDD999"
    "BBBB67636E0EECCCDDDC999FBBB9333E"
)


def gen_gb() -> bytes:
    a = Asm(base=0x0000)   # relative fixups only — base irrelevant

    def jr(op, label):
        a.db(op); a._fix(label, "rel8"); a.db(0)

    a.label("main")                 # code physically placed at $0150
    a.db(0xF3)                      # di
    a.db(0x31, 0xFE, 0xFF)          # ld sp,$FFFE
    a.label("w1")
    a.db(0xF0, 0x44)                # ldh a,($44) — LY
    a.db(0xFE, 0x90)                # cp $90
    jr(0x38, "w1")                  # jr c,w1  (wait LY >= $90)
    a.db(0xAF)                      # xor a
    a.db(0xE0, 0x40)                # ldh ($40),a — LCD off
    a.db(0x21, 0x00, 0x80)          # ld hl,$8000
    a.db(0x01, 0x00, 0x20)          # ld bc,$2000
    a.label("clr")
    a.db(0xAF)                      # xor a
    a.db(0x22)                      # ld (hl+),a
    a.db(0x0B)                      # dec bc
    a.db(0x78, 0xB1)                # ld a,b / or c
    jr(0x20, "clr")                 # jr nz,clr — clear all VRAM
    a.db(0x3E, 0xE7, 0xE0, 0x47)    # ld a,$E7 / ldh ($47),a — BGP: black
    a.db(0x3E, 0x91, 0xE0, 0x40)    # ld a,$91 / ldh ($40),a — LCD on, BG on
    a.label("loop")
    a.db(0xF0, 0x44)                # ldh a,($44)
    a.db(0xFE, 0x90)
    jr(0x38, "loop")                # wait vblank
    a.db(0x3E, 0x10, 0xE0, 0x00)    # ld a,$10 / ldh ($00),a — select buttons
    a.db(0xF0, 0x00)                # ldh a,($00)
    a.db(0xF0, 0x00)                # (line settle)
    a.db(0x2F)                      # cpl — pressed reads as 1
    a.db(0xE6, 0x01)                # and $01 — A button
    jr(0x20, "pressed")             # jr nz,pressed
    a.db(0x3E, 0xE7)                # ld a,$E7 — black
    jr(0x18, "setp")
    a.label("pressed")
    a.db(0x3E, 0xE4)                # ld a,$E4 — white
    a.label("setp")
    a.db(0xE0, 0x47)                # ldh ($47),a
    jr(0x18, "loop")
    a.resolve()

    code = bytes(a.out)
    assert 0x150 + len(code) <= 0x4000, "GB code overflows"
    rom = bytearray(0x8000)
    rom[0x100:0x104] = b"\x00\xC3\x50\x01"          # nop; jp $0150
    rom[0x104:0x134] = GB_LOGO                       # boot logo (format requirement)
    rom[0x134:0x143] = b"TESTGB".ljust(15, b"\x00")  # title (15 bytes)
    rom[0x143] = 0x00                                # not CGB-only
    rom[0x147] = 0x00                                # ROM only
    rom[0x148] = 0x00                                # 32KB
    rom[0x149] = 0x00                                # no cart RAM
    rom[0x14A] = 0x01                                # non-JP
    rom[0x14B] = 0x33                                # new licensee
    rom[0x14C] = 0x00                                # version
    x = 0
    for i in range(0x134, 0x14D):
        x = (x - rom[i] - 1) & 0xFF
    rom[0x14D] = x                                   # header checksum
    rom[0x150:0x150 + len(code)] = code
    total = sum(rom) & 0xFFFF
    struct.pack_into(">H", rom, 0x14E, (total - rom[0x14E] - rom[0x14F]) & 0xFFFF)
    return bytes(rom)


# ──────────────────────────────────────────────────────────────
# SNES (6502 subset in emulation mode, LoROM)
# ──────────────────────────────────────────────────────────────
def gen_snes() -> bytes:
    a = Asm(base=0x8000)   # LoROM: file $0000 -> CPU $00:8000

    def branch(op, label):
        a.db(op); a._fix(label, "rel8"); a.db(0)

    def jmp(label):
        a.db(0x4C); a._fix(label, "abs16"); a.db(0, 0)

    def sta(addr):                       # sta abs
        a.db(0x8D, addr & 0xFF, (addr >> 8) & 0xFF)

    a.label("reset")
    a.db(0x78)                          # sei
    a.db(0xD8)                          # cld
    a.db(0xA2, 0xFF, 0x9A)              # ldx #$FF / txs
    a.db(0xA9, 0x8F); sta(0x2100)       # INIDISP = forced blank
    a.db(0xA9, 0x00); sta(0x4200)       # NMITIMEN = 0 (NMI/IRQ off)
    a.db(0xA9, 0x00); sta(0x2121)       # CGADD = 0
    a.db(0xA9, 0x00); sta(0x2122)       # CGRAM 0 low  = $00
    a.db(0xA9, 0x7C); sta(0x2122)       # CGRAM 0 high = $7C  -> blue $7C00
    a.db(0xA9, 0x0F); sta(0x2100)       # display on, brightness 15
    a.label("loop")
    a.db(0xAD, 0x12, 0x42)              # lda $4212 (HVBJOY)
    a.db(0x29, 0x80)                    # and #$80 (vblank flag)
    branch(0xF0, "loop")                # beq loop — wait for vblank
    a.db(0xA9, 0x01); sta(0x4016)       # manual pad strobe
    a.db(0xA9, 0x00); sta(0x4016)
    a.db(0xA2, 0x08)                    # ldx #$08
    a.label("joy")
    a.db(0xAD, 0x16, 0x40)              # lda $4016 (serial, B first)
    a.db(0x4A)                          # lsr A
    a.db(0x06, 0x00)                    # rol $00
    a.db(0xCA)
    branch(0xD0, "joy")                 # bne joy
    # SNES order B,Y,Select,Start,Up,Down,Left,Right — B ends in bit 7
    a.db(0xA5, 0x00, 0x29, 0x80)        # lda $00 / and #$80 (B button)
    branch(0xF0, "blue")                # beq blue
    a.db(0xA9, 0x00); sta(0x2121)       # CGADD = 0
    a.db(0xA9, 0x1F); sta(0x2122)       # red $001F — low
    a.db(0xA9, 0x00); sta(0x2122)       #            high
    jmp("cont")
    a.label("blue")
    a.db(0xA9, 0x00); sta(0x2121)       # CGADD = 0
    a.db(0xA9, 0x00); sta(0x2122)       # blue $7C00 — low
    a.db(0xA9, 0x7C); sta(0x2122)       #             high
    a.label("cont")
    jmp("loop")

    a.label("stub"); a.db(0x40)         # rti
    a.resolve()

    rom = bytearray(a.out)
    assert a.labels["reset"] == 0x8000
    rom += b"\x00" * (0x8000 - len(rom))
    # vectors first (checksum is computed over the whole image afterwards)
    stub, reset = a.labels["stub"], a.labels["reset"]
    struct.pack_into("<HHHHHH", rom, 0x7FE4,
                     stub, reset, stub,      # COP, BRK, ABORT (native)
                     stub, reset, stub)      # NMI, RESET, IRQ  (native)
    struct.pack_into("<HHH", rom, 0x7FFA,
                     stub, reset, stub)      # NMI, RESET, IRQ  (emulation)
    # header at $7FC0
    rom[0x7FC0:0x7FD5] = b"ROMULATOR2K TEST".ljust(21, b" ")
    rom[0x7FD5] = 0x20        # LoROM, slow
    rom[0x7FD6] = 0x00        # ROM only
    rom[0x7FD7] = 0x05        # 32KB
    rom[0x7FD8] = 0x00        # no SRAM
    rom[0x7FD9] = 0x01        # destination
    rom[0x7FDA] = 0x01        # old licensee
    rom[0x7FDB] = 0x00        # version
    rom[0x7FDC:0x7FE0] = b"\x00\x00\x00\x00"
    s = sum(rom) & 0xFFFF
    struct.pack_into("<HH", rom, 0x7FDC, s ^ 0xFFFF, s)
    return bytes(rom)


# ──────────────────────────────────────────────────────────────
# Genesis / Mega Drive (68000)
# ──────────────────────────────────────────────────────────────
def gen_md() -> bytes:
    a = Asm68K(base=0x0200)

    def emit(*words_and_bytes):
        for x in words_and_bytes:
            if isinstance(x, int):
                if x <= 0xFF:
                    a.out.append(x)
                else:
                    a.out += struct.pack(">H", x & 0xFFFF)
            else:
                a.out += x

    def bcc8(opbyte, label):        # 2 bytes: op, rel8
        a.out.append(opbyte)
        a._fix(label, "rel8")
        a.out.append(0)

    def move_b_imm_abs(imm, addr):  # 13 FC imm.w addr.l  (imm right-justified)
        a.out += struct.pack(">HH", 0x13FC, imm & 0xFF)
        a.out += struct.pack(">I", addr)

    def move_l_imm_abs(imm, addr):  # 23 FC imm.l addr.l
        a.out += struct.pack(">HI", 0x23FC, imm & 0xFFFFFFFF)
        a.out += struct.pack(">I", addr)

    def move_w_imm_abs(imm, addr):  # 33 FC imm.w addr.l
        a.out += struct.pack(">HH", 0x33FC, imm & 0xFFFF)
        a.out += struct.pack(">I", addr)

    def move_b_abs_d0(addr):        # 10 39 addr.l
        a.out += struct.pack(">HI", 0x1039, addr)

    def move_w_abs_d0(addr):        # 30 39 addr.l
        a.out += struct.pack(">HI", 0x3039, addr)

    def nop():
        a.out += struct.pack(">H", 0x4E71)

    def btst_d0(bit):               # 08 00 bit.w
        a.out += struct.pack(">HH", 0x0800, bit & 0x1F)

    # ── program ──
    a.label("start")
    move_l_imm_abs(0x53454741, 0xA14000)   # TMSS: write "SEGA" (no-op without TMSS)
    move_b_imm_abs(0x40, 0xA10009)         # Port A CTRL: TH (bit6) as output
    # reg0 bit2 (0x04) = Palette Mode: without it color_update_m5 masks every
    # CRAM colour to 00X00X00X (GPGX vdp_render.c:1126) -> dim 3-bit colours.
    move_w_imm_abs(0x8004, 0xC00004)       # VDP reg0 = $04 (full 9-bit palette)
    # reg1 bit2 (0x04) = Mode 5 flag: GPGX gates the 2-word control latch on it
    # (vdp_ctrl.c:809 pending = reg[1] & 4) and blocks regs 11-23 without it.
    move_w_imm_abs(0x8104, 0xC00004)       # VDP reg1 = $04 (Mode 5, display off)
    move_l_imm_abs(0xC0000000, 0xC00004)   # CRAM write address 0
    move_w_imm_abs(0x0E00, 0xC00000)       # palette 0 colour 0 = blue
    move_w_imm_abs(0x8144, 0xC00004)       # VDP reg1 = $44 (Mode 5, display on)

    a.label("main")
    a.label("waitvb")
    move_w_abs_d0(0xC00004)                # status register
    btst_d0(3)                             # bit3 = vblank
    bcc8(0x67, "waitvb")                   # beq waitvb (Z = bit clear)
    # 3-button read: Port A DATA ($A10003). TH=1 (d-pad), TH=0 (A,B,C,Start;
    # 0 = pressed). TH is driven through the data port (ctrl = $A10009).
    move_b_imm_abs(0x40, 0xA10003)         # TH = 1
    nop(); nop()
    move_b_abs_d0(0xA10003)                # d-pad sample (ignored)
    move_b_imm_abs(0x00, 0xA10003)         # TH = 0
    nop(); nop()
    move_b_abs_d0(0xA10003)                # buttons sample
    btst_d0(0)                             # A
    bcc8(0x67, "pressed")                  # beq pressed
    move_l_imm_abs(0xC0000000, 0xC00004)
    move_w_imm_abs(0x0E00, 0xC00000)       # blue
    bcc8(0x60, "main")                     # bra main
    a.label("pressed")
    move_l_imm_abs(0xC0000000, 0xC00004)
    move_w_imm_abs(0x000E, 0xC00000)       # red (RRR at bits 3-1)
    bcc8(0x60, "main")                     # bra main
    a.label("halt")
    bcc8(0x60, "halt")                     # bra self
    a.resolve()

    code = bytes(a.out)
    assert 0x200 + len(code) <= 0x1000, "Genesis code overflows into header"
    rom = bytearray(0x8000)
    # 68000 vectors: SSP, PC, then exceptions -> halt
    struct.pack_into(">II", rom, 0x000, 0x00FFFF00, 0x00000200)
    halt = a.labels["halt"]
    for v in range(2, 64):
        struct.pack_into(">I", rom, 0x008 + (v - 2) * 4, halt)
    # Sega header at $100
    rom[0x100:0x110] = b"SEGA MEGA DRIVE ".ljust(16, b" ")
    rom[0x110:0x120] = b"(C)ROMULATOR2K26"   # exactly 16 bytes
    rom[0x120:0x140] = b"TEST ROM".ljust(32, b" ")
    rom[0x140:0x160] = b"TEST ROM".ljust(32, b" ")
    rom[0x160:0x16C] = b"GM 00000001-00"[:12].ljust(12, b" ")
    struct.pack_into(">II", rom, 0x170, 0x00000000, 0x00007FFF)   # ROM range
    struct.pack_into(">II", rom, 0x178, 0x00FF0000, 0x00FFFFFF)   # RAM range
    rom[0x180:0x190] = b" " * 16        # no SRAM (spaces, NOT "RA")
    rom[0x190:0x1A0] = b" " * 16        # modem
    rom[0x1F0:0x200] = b"JUE" + b" " * 13   # region: Japan/US/Europe
    # code at $200 — before checksum so it's covered
    rom[0x200:0x200 + len(code)] = code
    assert len(rom) == 0x8000, f"header section corrupted size: {len(rom)}"
    # checksum over all 16-bit words with the fields zeroed
    rom[0x16C:0x170] = b"\x00\x00\x00\x00"
    s = 0
    for i in range(0, len(rom), 2):
        s = (s + (rom[i] << 8) + rom[i + 1]) & 0xFFFF
    struct.pack_into(">HH", rom, 0x16C, s ^ 0xFFFF, s)
    return bytes(rom)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    roms = {
        "test.nes": gen_nes(),
        "test.gb":  gen_gb(),
        "test.sfc": gen_snes(),
        "test.md":  gen_md(),
    }
    for name, data in roms.items():
        (OUT / name).write_bytes(data)
        print(f"{name:10} {len(data):>7} bytes  head={data[:4].hex()}")


if __name__ == "__main__":
    main()
