//! A phone's screen frame, RGBA as Android's ImageReader gives it, made I420 for the page (`ScreenCapture.kt` calls this
//! through JNI): BT.709 studio range, chroma from each 2×2 block's mean, the very numbers the Kotlin code used. Plain
//! (Cb's weights sum to zero: −26 −86 +112, so grey stays grey) loops over whole rows, which the compiler turns into NEON on a phone: several times faster than the same in Kotlin,
//! where every frame cost a sizeable share of a core and the show stuttered.

/// Writes the I420 picture of `width`×`height` RGBA pixels (`pixel` bytes each, rows `stride` bytes apart) into `out`:
/// Y, then U, then V. False, and nothing written, when the sizes do not fit (an odd frame is skipped, not drawn wrong).
pub fn rgba_to_i420(src: &[u8], stride: usize, pixel: usize, width: usize, height: usize, out: &mut [u8]) -> bool {
    let width = width & !1;
    let height = height & !1;
    if width < 2 || height < 2 || pixel < 3 || stride < width * pixel {
        return false;
    }
    // The last row may stop right after its last pixel.
    if src.len() < stride * (height - 1) + width * pixel {
        return false;
    }
    let y_size = width * height;
    let c_width = width / 2;
    let c_size = c_width * (height / 2);
    if out.len() < y_size + 2 * c_size {
        return false;
    }
    let (y_plane, chroma) = out.split_at_mut(y_size);
    let (u_plane, v_plane) = chroma.split_at_mut(c_size);
    for row in 0..height {
        let line = &src[row * stride..row * stride + width * pixel];
        let ys = &mut y_plane[row * width..(row + 1) * width];
        for (y, px) in ys.iter_mut().zip(line.chunks_exact(pixel)) {
            let (r, g, b) = (px[0] as u32, px[1] as u32, px[2] as u32);
            *y = (((47 * r + 157 * g + 16 * b + 128) >> 8) + 16) as u8;
        }
    }
    for row in 0..height / 2 {
        let top = &src[2 * row * stride..2 * row * stride + width * pixel];
        let bottom = &src[(2 * row + 1) * stride..(2 * row + 1) * stride + width * pixel];
        let us = &mut u_plane[row * c_width..(row + 1) * c_width];
        let vs = &mut v_plane[row * c_width..(row + 1) * c_width];
        for (((u, v), a), c) in us.iter_mut().zip(vs.iter_mut()).zip(top.chunks_exact(2 * pixel)).zip(bottom.chunks_exact(2 * pixel)) {
            let sum = |i: usize| a[i] as i32 + a[pixel + i] as i32 + c[i] as i32 + c[pixel + i] as i32;
            let (r, g, b) = (sum(0), sum(1), sum(2));
            // Sums of four: the shift is two more than for one pixel.
            *u = (((-26 * r - 86 * g + 112 * b + 512) >> 10) + 128).clamp(0, 255) as u8;
            *v = (((112 * r - 102 * g - 10 * b + 512) >> 10) + 128).clamp(0, 255) as u8;
        }
    }
    true
}

/// `ScreenCapture.rgbaToI420` in Kotlin: both buffers are direct, so nothing is copied on the way.
#[cfg(target_os = "android")]
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_hatavoice_app_ScreenCapture_rgbaToI420(
    env: jni::JNIEnv,
    _this: jni::objects::JObject,
    src: jni::objects::JByteBuffer,
    stride: jni::sys::jint,
    pixel: jni::sys::jint,
    width: jni::sys::jint,
    height: jni::sys::jint,
    out: jni::objects::JByteBuffer,
) -> jni::sys::jboolean {
    let done = (|| -> Option<bool> {
        let (from, from_len) = (env.get_direct_buffer_address(&src).ok()?, env.get_direct_buffer_capacity(&src).ok()?);
        let (to, to_len) = (env.get_direct_buffer_address(&out).ok()?, env.get_direct_buffer_capacity(&out).ok()?);
        if from.is_null() || to.is_null() || [stride, pixel, width, height].iter().any(|v| *v <= 0) {
            return None;
        }
        // SAFETY: both are direct buffers Java keeps alive for this call; their addresses and capacities come from the VM,
        // and the two never overlap (one is the camera's image, the other ours).
        let (from, to) = unsafe { (std::slice::from_raw_parts(from, from_len), std::slice::from_raw_parts_mut(to, to_len)) };
        Some(rgba_to_i420(from, stride as usize, pixel as usize, width as usize, height as usize, to))
    })();
    if done == Some(true) { jni::sys::JNI_TRUE } else { jni::sys::JNI_FALSE }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The Kotlin code this replaces, pixel by pixel.
    fn reference(src: &[u8], stride: usize, pixel: usize, width: usize, height: usize) -> Vec<u8> {
        let mut out = vec![0u8; width * height * 3 / 2];
        for y in 0..height {
            for x in 0..width {
                let p = y * stride + x * pixel;
                let (r, g, b) = (src[p] as i32, src[p + 1] as i32, src[p + 2] as i32);
                out[y * width + x] = (((47 * r + 157 * g + 16 * b + 128) >> 8) + 16) as u8;
            }
        }
        let cw = width / 2;
        let (u0, v0) = (width * height, width * height + cw * (height / 2));
        for cy in 0..height / 2 {
            for cx in 0..cw {
                let a = 2 * cy * stride + 2 * cx * pixel;
                let c = a + stride;
                let s = |i: usize| src[a + i] as i32 + src[a + pixel + i] as i32 + src[c + i] as i32 + src[c + pixel + i] as i32;
                out[u0 + cy * cw + cx] = (((-26 * s(0) - 86 * s(1) + 112 * s(2) + 512) >> 10) + 128).clamp(0, 255) as u8;
                out[v0 + cy * cw + cx] = (((112 * s(0) - 102 * s(1) - 10 * s(2) + 512) >> 10) + 128).clamp(0, 255) as u8;
            }
        }
        out
    }

    #[test]
    fn makes_the_same_picture_as_before_with_padded_rows() {
        let (width, height, pixel, stride) = (18, 6, 4, 18 * 4 + 12);
        let mut seed = 7u32;
        let src: Vec<u8> = (0..stride * height)
            .map(|_| {
                seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
                (seed >> 16) as u8
            })
            .collect();
        let mut out = vec![0u8; width * height * 3 / 2];
        assert!(rgba_to_i420(&src, stride, pixel, width, height, &mut out));
        assert_eq!(out, reference(&src, stride, pixel, width, height));
    }

    #[test]
    fn white_black_and_studio_range() {
        let (width, height) = (2, 2);
        let white = vec![255u8; width * height * 4];
        let mut out = vec![0u8; 6];
        assert!(rgba_to_i420(&white, width * 4, 4, width, height, &mut out));
        assert_eq!(out, [235, 235, 235, 235, 128, 128], "white is Y 235 and grey chroma");
        let black = vec![0u8; width * height * 4];
        assert!(rgba_to_i420(&black, width * 4, 4, width, height, &mut out));
        assert_eq!(out, [16, 16, 16, 16, 128, 128]);
    }

    #[test]
    fn refuses_what_does_not_fit_and_writes_nothing() {
        let mut out = vec![9u8; 6];
        assert!(!rgba_to_i420(&[0; 15], 8, 4, 2, 2, &mut out), "source too short");
        assert!(!rgba_to_i420(&[0; 16], 4, 4, 2, 2, &mut out), "stride shorter than a row");
        assert!(!rgba_to_i420(&[0; 16], 8, 4, 2, 2, &mut [0u8; 5]), "no room for the picture");
        assert!(!rgba_to_i420(&[0; 16], 8, 2, 2, 2, &mut out), "not RGBA");
        assert_eq!(out, [9; 6]);
        // An odd size loses its last column and row rather than reading past them.
        let mut odd = vec![0u8; 6];
        assert!(rgba_to_i420(&[255; 3 * 3 * 4], 12, 4, 3, 3, &mut odd));
        assert_eq!(&odd[..4], &[235; 4]);
    }
}
