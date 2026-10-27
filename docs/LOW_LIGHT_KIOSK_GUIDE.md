# Low-Light Kiosk Deployment & Hardware Engineering Guide

## 1. Overview
The Attendance Kiosk application incorporates automated **Phase 4 Low-Light Handling** to ensure dependable biometric verification across variable lighting conditions:
- **Automatic Low-Light Detection**: The native pipeline monitors face region luma ($\mu_Y$). When $\mu_Y < 60$ for $\ge 500\text{ms}$, the system activates fill-light mode.
- **Hardware Screen Fill-Light**: Window brightness is programmatically boosted to 100% (`screenBrightness = 1.0f`), and a high-luminance white illumination border is rendered around the screen perimeter to illuminate the user's face.
- **Exposure Compensation**: Camera auto-exposure bias is dynamically elevated by $+1.5\text{ EV}$ to maintain contrast without introducing motion blur (shutter capped at $\le 1/30\text{s}$ at $30\text{ FPS}$).
- **Rejection Safety Gate**: If ambient illumination remains below the strict quality threshold ($\mu_Y < 40$ or $>25\%$ clipped pixels), the pipeline rejects inference and prompts `"Move to better light"`, preventing degraded biometric templates.
- **Color Integrity**: CLAHE and synthetic gamma enhancements are deliberately disabled on the inference path to avoid distorting EdgeFace-S float32 embeddings.

---

## 2. Hardware Recommendations for Fixed Kiosk Deployments

While screen fill-light provides an effective software assist for mobile devices and moderately dim indoor environments, **mission-critical fixed attendance kiosks operating in challenging or near-zero lux environments (e.g., night shifts, underground facilities, poorly lit factory gates)** should deploy purpose-built hardware:

### A. Dedicated Tablet with Near-Infrared (NIR) Sensor & IR Illuminators
- **Recommended Architecture**: Dual-sensor (RGB + IR) kiosk terminals (e.g., Telpo, Sunmi, or custom Android tablets equipped with $850\text{nm}$ or $940\text{nm}$ IR flood LEDs).
- **Benefits**:
  - **Zero-Lux Operability**: Operates in total darkness without blinding users with harsh white screen flashes.
  - **Hardware Anti-Spoofing / Presentation Attack Detection (PAD)**: NIR reflection differential between live human skin and flat photo/video screens eliminates spoofing.
  - **Invariance to Ambient Lighting Shifts**: Eliminates the intra-class variance caused by harsh sunlight, shadows, or fluorescent bulb flicker.

### B. Fixed Kiosk Illumination Guidelines (for RGB-Only Deployments)
If deploying standard Android tablets without IR sensors:
1. **Mounting Height & Angle**: Mount tablet at $140\text{--}150\text{cm}$ from the floor with a $10^\circ\text{--}15^\circ$ upward tilt to capture subjects ranging from $150\text{cm}$ to $195\text{cm}$ standing $0.5\text{--}0.8\text{m}$ away.
2. **Diffuse Front Lighting**: Install a diffuse LED luminaire ($300\text{--}500\text{ lux}$, $4000\text{K}\text{--}5000\text{K}$ neutral white) directly above and slightly in front of the kiosk.
3. **Avoid Severe Backlighting**: Never place kiosks facing windows, open doors, or glass curtain walls where bright background backlight causes facial silhouetting.
