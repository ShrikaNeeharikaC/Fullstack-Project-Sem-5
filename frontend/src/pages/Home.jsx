import Navbar from "../components/Navbar.jsx";
import Footer from "../components/Footer.jsx";
import { mount } from "../lib/mount.jsx";

function HeroIllustration() {
  return (
    <svg viewBox="0 0 600 560" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="g1" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2c2360" />
          <stop offset="1" stopColor="#4433a0" />
        </linearGradient>
      </defs>
      <rect width="600" height="560" fill="url(#g1)" />
      {/* laptop */}
      <rect x="150" y="330" width="300" height="18" rx="4" fill="#8d93f2" opacity="0.9" />
      <path d="M175 330 L195 200 A10 10 0 0 1 205 192 L395 192 A10 10 0 0 1 405 200 L425 330 Z" fill="#1c1740" stroke="#8d93f2" strokeWidth="2" />
      <rect x="205" y="205" width="190" height="112" rx="4" fill="#0f0c26" />
      {/* scan lines on screen */}
      <rect x="220" y="220" width="70" height="8" rx="2" fill="#8d93f2" opacity="0.8" />
      <rect x="220" y="236" width="110" height="6" rx="2" fill="#5c56a8" />
      <rect x="220" y="248" width="90" height="6" rx="2" fill="#5c56a8" />
      <rect x="220" y="270" width="150" height="34" rx="4" fill="#241a49" stroke="#8d93f2" strokeWidth="1.5" />
      <circle cx="240" cy="287" r="6" fill="#f2994a" />
      <rect x="255" y="283" width="90" height="8" rx="2" fill="#8d93f2" opacity="0.7" />
      {/* floating bug detection panels */}
      <g opacity="0.95">
        <rect x="70" y="90" width="150" height="86" rx="12" fill="#1c1740" stroke="#8d93f2" strokeWidth="1.5" />
        <circle cx="110" cy="130" r="22" fill="none" stroke="#e14434" strokeWidth="3" />
        <path d="M110 118 L110 132 M110 140 L110 141" stroke="#e14434" strokeWidth="3" strokeLinecap="round" />
        <rect x="145" y="118" width="55" height="7" rx="3" fill="#8d93f2" />
        <rect x="145" y="132" width="40" height="6" rx="3" fill="#5c56a8" />
        <rect x="145" y="145" width="45" height="6" rx="3" fill="#5c56a8" />
      </g>
      <g opacity="0.95">
        <rect x="370" y="70" width="150" height="100" rx="12" fill="#1c1740" stroke="#8d93f2" strokeWidth="1.5" />
        <path d="M390 150 L410 110 L430 140 L450 95 L470 130 L490 100" fill="none" stroke="#2fae73" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="390" y="90" width="60" height="7" rx="3" fill="#8d93f2" />
      </g>
      <g opacity="0.95">
        <rect x="400" y="220" width="140" height="90" rx="12" fill="#1c1740" stroke="#8d93f2" strokeWidth="1.5" />
        <circle cx="440" cy="260" r="24" fill="none" stroke="#f2c94c" strokeWidth="8" strokeDasharray="60 90" transform="rotate(-90 440 260)" />
        <rect x="475" y="245" width="50" height="7" rx="3" fill="#8d93f2" />
        <rect x="475" y="260" width="40" height="6" rx="3" fill="#5c56a8" />
        <rect x="475" y="273" width="45" height="6" rx="3" fill="#5c56a8" />
      </g>
      {/* hand/cursor accent */}
      <circle cx="300" cy="470" r="3" fill="#f2c94c" />
      <circle cx="330" cy="480" r="3" fill="#8d93f2" />
      <circle cx="270" cy="485" r="3" fill="#e14434" />
    </svg>
  );
}

const STEPS = [
  ["Drop in your URL", "Point BugOps at your hosted app — no installs, no config files, no code changes."],
  ["We crawl & detect", "Our scanner walks every page, checking for broken links, console errors, layout and performance issues."],
  ["Get root causes & fixes", "Every bug ships with a root cause analysis and a suggested fix, ready for your dashboard."],
];

function Home() {
  return (
    <>
      <Navbar active="home" />

      <section className="hero">
        <div className="hero-media">
          <HeroIllustration />
        </div>
        <div className="hero-copy">
          <span className="eyebrow"><span className="dot"></span> AI-Powered Bug Detection</span>
          <h1>Find Bugs Before Your Users Do</h1>
          <p>BugOps scans your hosted application, pinpoints root causes, and suggests fixes automatically. Just drop in your URL and let us handle the rest.</p>
          <a href="scan.html" className="btn btn-cream">Scan your app &nbsp;&#8594;</a>
          <span className="trust-line">No setup required. Takes less than 60 seconds.</span>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="section-heading">
            <h2>How BugOps works</h2>
            <p>Three steps between you and a bug-free release.</p>
          </div>
          <div className="steps-grid">
            {STEPS.map(([title, text], i) => (
              <div className="step-card" key={title}>
                <div className="step-num">{i + 1}</div>
                <h3>{title}</h3>
                <p>{text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <Footer />
    </>
  );
}

mount(Home);
