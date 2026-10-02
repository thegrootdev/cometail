"use client";
import { useEffect, useId, useRef, useState } from "react";
import { experience as copy } from "@/content/cometail";
import { TokenAvatar, Badge } from "./Experience";
export type TokenImage = { file: File; preview: string };
export function LogoUpload({
  onChange,
}: {
  onChange: (value: TokenImage | null) => void;
}) {
  const id = useId();
  const generation = useRef(0);
  const canvas = useRef<HTMLCanvasElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const preview = useRef<string | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1),
    [x, setX] = useState(0.5),
    [y, setY] = useState(0.5),
    [error, setError] = useState("");
  useEffect(
    () => () => {
      if (preview.current) URL.revokeObjectURL(preview.current);
    },
    [],
  );
  useEffect(
    () => () => {
      if (source) URL.revokeObjectURL(source);
    },
    [source],
  );
  useEffect(() => {
    if (!image || !canvas.current) return;
    let active = true;
    const ctx = canvas.current.getContext("2d");
    if (!ctx) return;
    const side = Math.min(image.naturalWidth, image.naturalHeight) / zoom;
    ctx.clearRect(0, 0, 512, 512);
    ctx.drawImage(
      image,
      (image.naturalWidth - side) * x,
      (image.naturalHeight - side) * y,
      side,
      side,
      0,
      0,
      512,
      512,
    );
    canvas.current.toBlob(
      (blob) => {
        if (!blob || !active) return;
        if (preview.current) URL.revokeObjectURL(preview.current);
        const url = URL.createObjectURL(blob);
        preview.current = url;
        onChange({
          file: new File([blob], "token.webp", { type: "image/webp" }),
          preview: url,
        });
      },
      "image/webp",
      0.9,
    );
    return () => {
      active = false;
    };
  }, [image, zoom, x, y, onChange]);
  const select = async (file?: File) => {
    if (!file) return;
    const current = ++generation.current;
    setError("");
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setError(copy.imageType);
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError(copy.imageSize);
      return;
    }
    const url = URL.createObjectURL(file);
    const next = new Image();
    next.onload = () => {
      if (current !== generation.current) {
        URL.revokeObjectURL(url);
        return;
      }
      if (
        next.naturalWidth < 128 ||
        next.naturalHeight < 128 ||
        next.naturalWidth > 8192 ||
        next.naturalHeight > 8192 ||
        next.naturalWidth * next.naturalHeight > 16777216
      ) {
        URL.revokeObjectURL(url);
        setError(copy.imageDimensions);
        return;
      }
      setZoom(1);
      setX(0.5);
      setY(0.5);
      setSource(url);
      setImage(next);
    };
    next.onerror = () => {
      URL.revokeObjectURL(url);
      setError(copy.imageError);
    };
    next.src = url;
  };
  const remove = () => {
    generation.current++;
    if (preview.current) URL.revokeObjectURL(preview.current);
    preview.current = null;
    setImage(null);
    setSource(null);
    onChange(null);
    if (input.current) input.current.value = "";
  };
  return (
    <div className="field">
      <span>{copy.image}</span>
      <input
        className="upload-input"
        ref={input}
        id={id}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={(e) => {
          void select(e.target.files?.[0]);
        }}
      />
      {!image ? (
        <div
          className="upload-drop"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void select(e.dataTransfer.files[0]);
          }}
        >
          <div className="upload-mark" aria-hidden="true">
            ✧
          </div>
          <div>
            <h3>{copy.dropImage}</h3>
            <p>{copy.imageHint}</p>
            <label className="text-link" htmlFor={id}>
              {copy.chooseImage} ↗
            </label>
          </div>
        </div>
      ) : (
        <>
          <div className="upload-crop">
            <div className="crop-frame">
              <canvas
                ref={canvas}
                width="512"
                height="512"
                aria-label={copy.crop}
              />
            </div>
            <div className="crop-controls">
              <label>
                {copy.zoom}
                <input
                  type="range"
                  min="1"
                  max="3"
                  step=".01"
                  value={zoom}
                  onChange={(e) => setZoom(Number(e.target.value))}
                />
              </label>
              <label>
                {copy.horizontal}
                <input
                  type="range"
                  min="0"
                  max="1"
                  step=".01"
                  value={x}
                  onChange={(e) => setX(Number(e.target.value))}
                />
              </label>
              <label>
                {copy.vertical}
                <input
                  type="range"
                  min="0"
                  max="1"
                  step=".01"
                  value={y}
                  onChange={(e) => setY(Number(e.target.value))}
                />
              </label>
            </div>
          </div>
          <div className="crop-actions">
            <label htmlFor={id} className="text-link">
              {copy.replaceImage}
            </label>
            <button type="button" onClick={remove}>
              {copy.remove}
            </button>
          </div>
        </>
      )}
      {error && (
        <p className="upload-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
export function IdentityPreview({
  name,
  symbol,
  image,
}: {
  name: string;
  symbol: string;
  image?: string;
}) {
  return (
    <div className="identity-preview">
      <div className="micro">{copy.preview}</div>
      <div className="preview-identity">
        <TokenAvatar seed={symbol || "comet"} image={image} size="large" />
        <div>
          <h3>{name || copy.tokenPlaceholder}</h3>
          <small>{symbol ? `$${symbol}` : copy.symbolPreview}</small>
        </div>
      </div>
      <div className="preview-bottom">
        <span>METEORA / DBC</span>
        <Badge tone="ion">{copy.identity}</Badge>
      </div>
    </div>
  );
}
