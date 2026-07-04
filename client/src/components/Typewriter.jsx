import { useEffect, useState } from 'react';

// Animação de máquina de escrever para títulos. Encadeie segmentos com delayStart.
export default function Typewriter({ text = '', speed = 38, delayStart = 0, cursor = false, className = '' }) {
  const [displayed, setDisplayed] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    setDisplayed('');
    setDone(false);
    let cancelled = false;
    let i = 0;
    const startTimer = setTimeout(function step() {
      if (cancelled) return;
      if (i >= text.length) { setDone(true); return; }
      setDisplayed(text.slice(0, i + 1));
      i++;
      setTimeout(step, speed);
    }, delayStart);
    return () => { cancelled = true; clearTimeout(startTimer); };
  }, [text, speed, delayStart]);

  return (
    <span className={`typewriter ${className}`} aria-label={text}>
      {displayed}
      {cursor && !done && <span className="typewriter-cursor">|</span>}
    </span>
  );
}
