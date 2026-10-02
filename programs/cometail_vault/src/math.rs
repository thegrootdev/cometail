//! Q64.64 price math matching DLMM's integer bin price: P(bin) = (1 + bin_step/10000)^bin.
//! No floating point anywhere; every intermediate is checked.

pub const ONE_Q64: u128 = 1u128 << 64;
pub const BASIS_POINT_MAX: u128 = 10_000;
/// DLMM's bin id range for the smallest bin step (`u64x64_math.rs`).
pub const MAX_ABS_BIN: i32 = 443_636;

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

/// 2^128 / p for p > 0 (fits in u128 whenever p >= 1).
fn inv_q128(p: u128) -> Option<u128> {
    if p == 0 { return None; }
    let q = u128::MAX / p;
    let r = u128::MAX % p;
    if r.checked_add(1)? == p { q.checked_add(1) } else { Some(q) }
}

fn pow_q64(base: u128, mut exp: u32) -> Option<u128> {
    let mut result = ONE_Q64;
    let mut b = base;
    while exp > 0 {
        if exp & 1 == 1 { result = mul_shr64(result, b)?; }
        exp >>= 1;
        if exp > 0 { b = mul_shr64(b, b)?; }
    }
    Some(result)
}

/// Bin price in Q64: (1 + bin_step/10000)^bin, inverted for negative bins the way DLMM does it.
pub fn price_q64(bin_step: u16, bin: i32) -> Option<u128> {
    if bin.unsigned_abs() > MAX_ABS_BIN as u32 { return None; }
    let bps = (bin_step as u128).checked_shl(64)? / BASIS_POINT_MAX;
    let base = ONE_Q64.checked_add(bps)?;
    let p = pow_q64(base, bin.unsigned_abs())?;
    if bin >= 0 { Some(p) } else { inv_q128(p) }
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

/// Largest |bin| whose price is representable for this bin step (the power does not
/// overflow u128). DLMM's own limit for 1 bps is 443,636; wider steps saturate sooner.
pub fn max_abs_bin(bin_step: u16) -> i32 {
    let (mut lo, mut hi) = (0i32, MAX_ABS_BIN);
    while lo < hi {
        let mid = lo + (hi - lo + 1) / 2;
        if price_q64(bin_step, mid).is_some() { lo = mid; } else { hi = mid - 1; }
    }
    lo
}

/// `max_abs_bin` for the approved bin steps, fixed so `create_vault` does not search for it
/// (the unit test below pins every entry to the computed value).
pub const MAX_ABS_BIN_BY_STEP: [(u16, i32); 6] = [(10, 44_383), (20, 22_202), (25, 17_766), (50, 8_894), (80, 5_567), (100, 4_458)];

/// Does the cap admit at least one bin in both orientations on this bin step? That is what
/// `bin_bound` needs: the lowest price within the cap for ST = X, the highest for ST = Y.
pub fn cap_feasible(bin_step: u16, cap_q64: u128) -> bool {
    let m = match MAX_ABS_BIN_BY_STEP.iter().find(|(s, _)| *s == bin_step) { Some((_, m)) => *m, None => max_abs_bin(bin_step) };
    bin_within_cap(bin_step, -m, cap_q64, true) && bin_within_cap(bin_step, m, cap_q64, false)
}

/// The bound bin: the largest bin within the cap when ST is X (bids go below it), the
/// smallest bin within the cap when ST is Y (bids go above it). None when no bin qualifies.
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
        assert_eq!(p1, ONE_Q64 + (ONE_Q64 / 100)); // 1.01
        let m1 = price_q64(100, -1).unwrap();
        assert!(m1 < ONE_Q64 && m1 > ONE_Q64 - ONE_Q64 / 100);
        assert!(price_q64(100, 10).unwrap() > p1);
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
            assert!(!cap_feasible(step, 1)); // below the lowest representable price
            assert!(cap_feasible(step, ONE_Q64) == (bin_bound(step, ONE_Q64, true).is_some() && bin_bound(step, ONE_Q64, false).is_some()));
        }
    }
    #[test]
    fn bounds() {
        // cap exactly 1.01 with ST = X: bins 0 and 1 qualify, 2 does not
        let cap = price_q64(100, 1).unwrap();
        assert_eq!(bin_bound(100, cap, true), Some(1));
        // ST = Y: price is Y per X = WSOL per ST... the cap is lamports per ST, so the bound is 1/cap: bins >= -1
        // the inverse price rounds down, so the bound may land one bin stricter than -1
        let y = bin_bound(100, cap, false).unwrap();
        assert!(y == -1 || y == 0);
        assert!(bin_within_cap(100, y, cap, false));
        assert!(!bin_within_cap(100, -2, cap, false));
        assert!(bin_within_cap(100, 5, cap, false));
    }
}

