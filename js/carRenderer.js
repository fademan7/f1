/**
 * carRenderer.js
 */

// 차체 크기 기준값 (기존 8배에서 보기 좋은 2.5배 스케일로 축소 및 최적화)
const CAR_LENGTH_BASE = 160;
const CAR_WIDTH_BASE = 80;

// 위에서 본 F1 차량 실루엣 (비율 좌표)
const F1_BODY_SHAPE = [
  [0.50, 0.00], [0.40, 0.16], [0.36, 0.44], [0.28, 0.44],
  [0.24, 0.18], [0.08, 0.22], [0.02, 0.48], [-0.16, 0.44],
  [-0.34, 0.48], [-0.34, -0.48], [-0.16, -0.44], [0.02, -0.48],
  [0.08, -0.22], [0.24, -0.18], [0.28, -0.44], [0.36, -0.44],
  [0.40, -0.16]
];

export class CarRenderer {
  constructor() {
    this.trails = new Map();
  }

  // 타이어 궤적(잔상) 비활성화
  updateTrail() {} 
  drawTrail() {} 

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

    // 차량 스케일에 맞춰 이름 크기를 쾌적하게 조절
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
}