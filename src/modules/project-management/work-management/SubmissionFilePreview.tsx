"use client";

import { FileText } from "lucide-react";
import { useEffect, useState } from "react";

export function SubmissionFilePreview({ file }: { file: File }) {
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const isText = file.type.startsWith("text/") || /\.(csv|json|md|log)$/i.test(file.name);

  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    if (isText) file.text().then(setText).catch(() => setText("Unable to preview this text file."));
    return () => URL.revokeObjectURL(objectUrl);
  }, [file, isText]);

  if (file.type.startsWith("image/") && url) return <img src={url} alt={`Preview of ${file.name}`} className="max-h-56 max-w-full rounded object-contain" />;
  if (file.type === "application/pdf" && url) return <iframe title={`Preview of ${file.name}`} src={url} className="h-56 w-full rounded border" />;
  if (file.type.startsWith("video/") && url) return <video controls src={url} className="max-h-56 max-w-full rounded" />;
  if (file.type.startsWith("audio/") && url) return <audio controls src={url} className="w-full" />;
  if (isText) return <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-left text-xs text-muted-foreground">{text || "Loading preview…"}</pre>;
  return <div className="flex items-center gap-2 text-xs text-muted-foreground"><FileText className="size-4" />Preview unavailable for this file type. The file will still be submitted.</div>;
}
