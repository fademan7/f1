/**
 * carRenderer.js
 */

const CAR_LENGTH_BASE = 160;
const CAR_WIDTH_BASE = 80;

const F1_BODY_SHAPE = [
  [0.50, 0.00], [0.40, 0.16], [0.36, 0.44], [0.28, 0.44],
  [0.24, 0.18], [0.08, 0.22], [0.02, 0.48], [-0.16, 0.44],
  [-0.34, 0.48], [-0.34, -0.48], [-0.16, -0.44], [0.02, -0.48],
  [0.08, -0.22], [0.24, -0.18], [0.28, -0.44], [0.36, -0.44],
  [0.40, -0.16]
];

export class CarRenderer {
  constructor() { this.trails = new Map(); }
  updateTrail() {} 
  drawTrail() {} 

  // 탑다운 뷰용 (기존)
  drawCar(ctx, screenX, screenY, heading, scale, opts) {
    const { color = '#ffffff', code = '', braking = false, selected = false } = opts;
    const length = CAR_LENGTH_BASE * scale;
    const width = CAR_WIDTH_BASE * scale;

    ctx.save();
    ctx.translate(screenX, screenY);

    if (selected) {
      ctx.beginPath();
      ctx.arc(0, 0, length * 0.85, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255, 230, 60, 0.9)';
      ctx.lineWidth = Math.max(1.5, scale * 1.2);
      ctx.setLineDash([length * 0.12, length * 0.08]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.rotate(heading);

    if (braking) {
      ctx.beginPath();
      ctx.fillStyle = 'rgba(255,40,40,0.55)';
      ctx.ellipse(-length * 0.58, 0, length * 0.22, width * 0.6, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = 'rgba(15,15,20,0.9)';
    ctx.fillRect(-length * 0.5, -width * 0.5, length * 0.16, width);

    ctx.beginPath();
    F1_BODY_SHAPE.forEach(([rx, ry], i) => {
      const x = rx * length;
      const y = ry * width;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = Math.max(1, scale * 0.5);
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.stroke();

    ctx.beginPath();
    ctx.ellipse(length * 0.02, 0, width * 0.16, width * 0.22, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(10,10,15,0.9)';
    ctx.fill();

    ctx.fillStyle = 'rgba(15,15,20,0.9)';
    ctx.fillRect(length * 0.40, -width * 0.46, length * 0.08, width * 0.92);

    ctx.restore();

    if (code) {
      ctx.save();
      ctx.font = `bold ${Math.min(36, Math.max(12, 22 * scale))}px 'Segoe UI', sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = 'rgba(0,0,0,0.9)';
      ctx.shadowBlur = 4;
      ctx.fillText(code, screenX, screenY - width * 0.9 - 6);
      ctx.restore();
    }
  }

  // 🏎️ 1인칭 FPV용 타 차량 뒷모습 렌더링
  drawRearCar(ctx, x, y, scale, color, isBraking) {
    ctx.save();
    ctx.translate(x, y);
    
    // 리어 타이어 (크고 두꺼운 사각형)
    ctx.fillStyle = '#111';
    ctx.fillRect(-1.4 * scale, -0.6 * scale, 0.5 * scale, 0.9 * scale); // 좌
    ctx.fillRect(0.9 * scale, -0.6 * scale, 0.5 * scale, 0.9 * scale);  // 우
    
    // 리어 윙
    ctx.fillStyle = '#222';
    ctx.fillRect(-1.1 * scale, -1.3 * scale, 2.2 * scale, 0.5 * scale); // 윙 하판
    ctx.fillStyle = color;
    ctx.fillRect(-1.0 * scale, -1.2 * scale, 2.0 * scale, 0.2 * scale); // 윙 상판 팀 컬러
    
    // 바디 (섀시 및 디퓨저)
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(-0.6 * scale, 0.2 * scale);
    ctx.lineTo(0.6 * scale, 0.2 * scale);
    ctx.lineTo(0.4 * scale, -0.9 * scale);
    ctx.lineTo(-0.4 * scale, -0.9 * scale);
    ctx.fill();
    
    // 점멸등 (브레이크 또는 ERS)
    ctx.fillStyle = isBraking ? '#ff3333' : '#880000';
    if (isBraking) ctx.boxShadow = `0 0 10px #ff3333`;
    ctx.fillRect(-0.15 * scale, -0.1 * scale, 0.3 * scale, 0.25 * scale);
    
    ctx.restore();
  }
}
