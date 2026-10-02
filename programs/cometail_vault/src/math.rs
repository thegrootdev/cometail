//! DLMM bin prices with the upstream integer algorithm, so every cap decision agrees with
//! what the pair itself computes: `price(bin) = (1 + bin_step/10000)^bin` in Q64.64,
//! `dlmm/commons/src/math/price_math.rs:3-14` on top of `u64x64_math.rs::pow`. No floating
//! point anywhere; every intermediate is checked.

pub const ONE_Q64: u128 = 1u128 << 64;
pub const BASIS_POINT_MAX: u128 = 10_000;
/// Exponent bits the upstream power loop walks (`u64x64_math.rs`, MAX_EXPONENTIAL).
const MAX_EXPONENTIAL: u32 = 0x80000;

/// (a * b) >> 64 with a 256-bit intermediate, None on overflow of the result.
pub fn mul_shr64(a: u128, b: u128) -> Option<u128> {
    let (a_hi, a_lo) = (a >> 64, a & 0xFFFF_FFFF_FFFF_FFFF);
    let (b_hi, b_lo) = (b >> 64, b & 0xFFFF_FFFF_FFFF_FFFF);
    let hh = a_hi.checked_mul(b_hi)?; // contributes hh << 64
    let hl = a_hi.checked_mul(b_lo)?;
    let lh = a_lo.checked_mul(b_hi)?;
    let ll = a_lo.checked_mul(b_lo)? >> 64;
    let hh_shifted = hh.checked_shl(64).filter(|_| hh >> 64 == 0)?;
    hh_shifted.checked_add(hl)?.checked_add(lh)?.checked_add(ll)
}

/// The upstream Q64.64 power (`dlmm/commons/src/math/u64x64_math.rs:24-176`), kept
/// step for step: a base at or above one is inverted first so the squarings stay inside
/// u128, nineteen exponent bits are walked with truncating multiplies, a zero result is
/// None, and the final inversion is `u128::MAX / result`.
pub fn pow_q64(base: u128, exp: i32) -> Option<u128> {
    let mut invert = exp.is_negative();
    if exp == 0 { return Some(ONE_Q64); }
    let exp: u32 = exp.unsigned_abs();
    if exp >= MAX_EXPONENTIAL { return None; }
    let mut squared_base = base;
    let mut result = ONE_Q64;
    if squared_base >= result {
        squared_base = u128::MAX.checked_div(squared_base)?;
        invert = !invert;
    }
    if exp & 0x1 > 0 { result = (result.checked_mul(squared_base)?) >> 64; }
    let mut bit = 0x2u32;
    while bit <= 0x40000 {
        squared_base = (squared_base.checked_mul(squared_base)?) >> 64;
        if exp & bit > 0 { result = (result.checked_mul(squared_base)?) >> 64; }
        bit <<= 1;
    }
    if result == 0 { return None; }
    if invert { result = u128::MAX.checked_div(result)?; }
    Some(result)
}

/// Bin price in Q64 exactly as DLMM computes it (`price_math.rs:3-14`).
pub fn price_q64(bin_step: u16, bin: i32) -> Option<u128> {
    let bps = (bin_step as u128).checked_shl(64)? / BASIS_POINT_MAX;
    let base = ONE_Q64.checked_add(bps)?;
    pow_q64(base, bin)
}

/// Does a bin satisfy the price cap? ST = X: P <= cap. ST = Y: P * cap >= 2^128.
pub fn bin_within_cap(bin_step: u16, bin: i32, cap_q64: u128, st_is_x: bool) -> bool {
    match price_q64(bin_step, bin) {
        None => false,
        Some(p) => {
            if st_is_x { p <= cap_q64 } else {
                // (p * cap) >> 64 >= 2^64  <=>  p * cap >= 2^128; an overflow of the shifted product
                // means p * cap >= 2^192, which satisfies it
                match mul_shr64(p, cap_q64) { Some(v) => v >= ONE_Q64, None => true }
            }
        }
    }
}

/// Largest |bin| for which the upstream power returns a price on this bin step (the
/// positive side saturates to None when a squaring overflows; the negative side mirrors it).
pub fn max_abs_bin(bin_step: u16) -> i32 {
    let (mut lo, mut hi) = (0i32, (MAX_EXPONENTIAL - 1) as i32);
    while lo < hi {
        let mid = lo + (hi - lo + 1) / 2;
        if price_q64(bin_step, mid).is_some() && price_q64(bin_step, -mid).is_some() { lo = mid; } else { hi = mid - 1; }
    }
    lo
}

/// `max_abs_bin` for the approved bin steps, fixed so `create_vault` does not search for it
/// (the unit test below pins every entry to the computed value).
pub const MAX_ABS_BIN_BY_STEP: [(u16, i32); 6] = [(10, 44_383), (20, 22_202), (25, 17_759), (50, 8_893), (80, 5_567), (100, 4_456)];

/// Does the cap admit at least one bin in both orientations on this bin step? That is what
/// `bin_bound` needs: the lowest price within the cap for ST = X, the highest for ST = Y.
pub fn cap_feasible(bin_step: u16, cap_q64: u128) -> bool {
    let m = match MAX_ABS_BIN_BY_STEP.iter().find(|(s, _)| *s == bin_step) { Some((_, m)) => *m, None => max_abs_bin(bin_step) };
    bin_within_cap(bin_step, -m, cap_q64, true) && bin_within_cap(bin_step, m, cap_q64, false)
}

/// The bound bin: the largest bin within the cap when ST is X (bids go below it), the
/// smallest bin within the cap when ST is Y (bids go above it). None when no bin qualifies.
/// Prices are monotone in the bin, so a binary search over the representable range is exact.
pub fn bin_bound(bin_step: u16, cap_q64: u128, st_is_x: bool) -> Option<i32> {
    let m = max_abs_bin(bin_step);
    let (mut lo, mut hi) = (-m, m);
    if st_is_x {
        // "within cap" holds for small bins and fails for large ones: find the last true
        if !bin_within_cap(bin_step, lo, cap_q64, true) { return None; }
        while lo < hi {
            let mid = lo + (hi - lo + 1) / 2;
            if bin_within_cap(bin_step, mid, cap_q64, true) { lo = mid; } else { hi = mid - 1; }
        }
        Some(lo)
    } else {
        // "within cap" fails for small bins and holds for large ones: find the first true
        if !bin_within_cap(bin_step, hi, cap_q64, false) { return None; }
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            if bin_within_cap(bin_step, mid, cap_q64, false) { hi = mid; } else { lo = mid + 1; }
        }
        Some(lo)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn price_identity_and_monotone() {
        assert_eq!(price_q64(100, 0), Some(ONE_Q64));
        let p1 = price_q64(100, 1).unwrap();
        assert!(p1 <= ONE_Q64 + (ONE_Q64 / 100) && p1 > ONE_Q64 + (ONE_Q64 / 100) - 4); // 1.01, truncating
        let m1 = price_q64(100, -1).unwrap();
        assert!(m1 < ONE_Q64 && m1 > ONE_Q64 - ONE_Q64 / 100);
        assert!(price_q64(100, 10).unwrap() > p1);
        for step in [10u16, 100] { for bin in -50..50 { assert!(price_q64(step, bin).unwrap() <= price_q64(step, bin + 1).unwrap()); } }
    }
    /// Values produced by compiling the pinned upstream `u64x64_math.rs` directly (the
    /// verifier's probe, spikes/14-acceptance/math-prices.csv).
    #[test]
    fn matches_upstream_rows() {
        assert_eq!(price_q64(100, 3), Some(19_005_698_865_887_024_741));
        assert_eq!(price_q64(100, -1), Some(18_264_103_043_276_783_778));
        assert_eq!(price_q64(100, -3), Some(17_904_228_059_285_152_217));
        assert_eq!(price_q64(10, -3), Some(18_391_514_337_761_738_776));
        assert_eq!(price_q64(10, 3), Some(18_502_139_664_609_645_473));
        assert_eq!(price_q64(80, 3), Some(18_893_017_151_073_698_829));
        assert_eq!(price_q64(50, 1), Some(18_538_977_794_078_099_374));
        assert_eq!(price_q64(10, 44_383), Some(u128::MAX));
        assert_eq!(price_q64(80, 5_567), Some(u128::MAX));
        assert_eq!(price_q64(20, 22_202), Some(u128::MAX));
        assert_eq!(price_q64(25, 17_766), None);
        assert_eq!(price_q64(50, 8_894), None);
        assert_eq!(price_q64(100, 4_458), None);
    }
    #[test]
    fn saturation() {
        assert!(max_abs_bin(100) > 4000 && max_abs_bin(100) < 4500);
        assert!(max_abs_bin(10) > 40_000);
        assert_eq!(bin_bound(100, 0, true), None); // no price is <= 0
    }
    #[test]
    fn saturation_table_matches() {
        for (step, m) in MAX_ABS_BIN_BY_STEP { assert_eq!(max_abs_bin(step), m, "bin step {step}"); }
    }
    #[test]
    fn feasibility() {
        for (step, _) in MAX_ABS_BIN_BY_STEP {
            assert!(cap_feasible(step, ONE_Q64));
            assert!(cap_feasible(step, ONE_Q64 * 10));
            // the saturation bins price at 1 and u128::MAX, so ST = X admits any cap; ST = Y needs price * cap >= 2^128, which a cap of 1 unit never reaches
            assert!(!cap_feasible(step, 1));
            assert!(cap_feasible(step, 2));
            assert!(cap_feasible(step, ONE_Q64) == (bin_bound(step, ONE_Q64, true).is_some() && bin_bound(step, ONE_Q64, false).is_some()));
        }
    }
    #[test]
    fn bounds() {
        // cap exactly price(3) with ST = X: bins up to 3 qualify, 4 does not (the verifier's adjacent-cap case)
        let cap = price_q64(100, 3).unwrap();
        assert_eq!(bin_bound(100, cap, true), Some(3));
        assert!(!bin_within_cap(100, 4, cap, true));
        // ST = Y: the cap is lamports per ST, so the bound is 1/cap: the first bin whose price * cap >= 2^128
        let y = bin_bound(100, cap, false).unwrap();
        assert!(y == -3 || y == -2);
        assert!(bin_within_cap(100, y, cap, false));
        assert!(!bin_within_cap(100, y - 1, cap, false));
        assert!(bin_within_cap(100, 5, cap, false));
    }
}
