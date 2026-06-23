#!/usr/bin/env python3
"""
SD 1.5 + LCM-LoRA 本地出图（Apple MPS 加速）
用法：python3 generate_image.py --prompt "..." [--steps 4] [--seed -1]
输出：base64 PNG（50×50）打到 stdout，供 server.js 读取

首次运行会下载模型到 ~/.cache/huggingface（SD1.5 fp16 ~2GB，LCM-LoRA ~200MB）。
如遇 HuggingFace 鉴权提示，运行：huggingface-cli login
依赖：pip3 install diffusers transformers accelerate torch pillow
"""
import argparse, base64, sys
from io import BytesIO


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--prompt',   required=True)
    p.add_argument('--negative', default='text, watermark, nsfw, ugly, deformed, blurry, low quality, duplicate, extra limbs')
    p.add_argument('--steps',    type=int, default=4)
    p.add_argument('--seed',     type=int, default=-1)
    args = p.parse_args()

    import torch
    from diffusers import StableDiffusionPipeline, LCMScheduler
    from PIL import Image

    device = 'mps' if torch.backends.mps.is_available() else 'cpu'
    dtype  = torch.float16

    print(f'[generate_image] device={device} steps={args.steps}', file=sys.stderr)

    # Counterfeit-V3.0 是单文件 safetensors，from_single_file 需分开传 repo_id 和 weight_name
    # fix_fp16 版本修复了 fp16 精度问题，体积最小（2.13GB）
    pipe = StableDiffusionPipeline.from_single_file(
        'https://huggingface.co/gsdf/Counterfeit-V3.0/blob/main/Counterfeit-V3.0_fix_fp16.safetensors',
        torch_dtype=dtype,
        safety_checker=None,
    ).to(device)

    # LCM-LoRA：把 25 步压到 4 步，M4 下 ~5s 出图
    pipe.scheduler = LCMScheduler.from_config(pipe.scheduler.config)
    pipe.load_lora_weights('latent-consistency/lcm-lora-sdv1-5')
    pipe.fuse_lora()   # 合并进基础权重，推理略快

    gen = torch.Generator(device=device).manual_seed(args.seed) if args.seed >= 0 else None

    result = pipe(
        prompt=args.prompt,
        negative_prompt=args.negative,
        num_inference_steps=args.steps,
        guidance_scale=1.0,   # LCM 固定 1.0，不用分类引导
        width=256,
        height=256,
        generator=gen,
    )

    # 直接输出 256×256 原图，缩放交给浏览器（CSS object-fit: cover）
    img = result.images[0]
    buf = BytesIO()
    img.save(buf, format='PNG')
    print(base64.b64encode(buf.getvalue()).decode())


if __name__ == '__main__':
    main()


"""
"""