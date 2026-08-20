import React, { useEffect, useRef, useState } from "react";
import "./App.css";

const API = "https://ai-interview-pro-ldry.onrender.com";

const DURATIONS = [
  { value: 15, label: "15 min", description: "Quick interview" },
  { value: 20, label: "20 min", description: "Standard" },
  { value: 30, label: "30 min", description: "Detailed" },
  { value: 45, label: "45 min", description: "Advanced" },
  { value: 60, label: "60 min", description: "Full interview" },
];

function App() {
  const videoRef = useRef(null);
  const cameraStreamRef = useRef(null);
  const screenStreamRef = useRef(null);
  const recognitionRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const recordingChunksRef = useRef([]);
  const interviewActiveRef = useRef(false);
  const timerEndRef = useRef(null);
  const endInterviewRef = useRef(null);
  const endingInterviewRef = useRef(false);

  const [resumeFile, setResumeFile] = useState(null);
  const [resumeId, setResumeId] = useState(null);

  const [duration, setDuration] = useState(15);

  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [microphoneEnabled, setMicrophoneEnabled] = useState(false);
  const [screenEnabled, setScreenEnabled] = useState(false);
  

  const [interviewStarted, setInterviewStarted] = useState(false);
  const [interviewId, setInterviewId] = useState(null);

  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");

  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);

  const [loading, setLoading] = useState(false);
  const [questionLoading, setQuestionLoading] = useState(false);

  const [timeLeft, setTimeLeft] = useState(duration * 60);

  const [events, setEvents] = useState([]);

  const [score, setScore] = useState(null);
  const [report, setReport] = useState(null);

  const [error, setError] = useState("");
  const [status, setStatus] = useState("Ready");

  // ------------------------------------------------------------
  // Utility
  // ------------------------------------------------------------

  function addEvent(message, type = "info") {
    setEvents((prev) => [
      {
        id: Date.now() + Math.random(),
        message,
        type,
        time: new Date().toLocaleTimeString(),
      },
      ...prev,
    ].slice(0, 30));
  }

  function getErrorMessage(error) {
    if (!error) return "Unknown error.";

    if (typeof error === "string") return error;

    if (error.message) return error.message;

    try {
      return JSON.stringify(error);
    } catch {
      return "Unknown error.";
    }
  }

  async function readResponse(response) {
    const text = await response.text();

    let data = {};

    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { detail: text };
    }

    if (!response.ok) {
      const detail =
        typeof data.detail === "string"
          ? data.detail
          : data.message ||
            data.error ||
            JSON.stringify(data);

      throw new Error(detail);
    }

    return data;
  }

  // ------------------------------------------------------------
  // Camera
  // ------------------------------------------------------------

  async function enableCameraAndMicrophone() {
    setError("");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });

      cameraStreamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }

      setCameraEnabled(true);
      setMicrophoneEnabled(true);

      addEvent("Camera and microphone enabled.", "success");
      setStatus("Camera + microphone ready");
    } catch (err) {
      console.error(err);

      setCameraEnabled(false);
      setMicrophoneEnabled(false);

      setError(
        "Camera/microphone permission was not granted. Please allow camera and microphone access."
      );

      addEvent("Camera/microphone permission failed.", "danger");
    }
  }

  // ------------------------------------------------------------
  // Screen sharing
  // ------------------------------------------------------------

  async function enableScreenSharing() {
    setError("");

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });

      screenStreamRef.current = stream;

      setScreenEnabled(true);

      addEvent("Screen sharing enabled.", "success");

      const videoTrack = stream.getVideoTracks()[0];

      if (videoTrack) {
        videoTrack.addEventListener("ended", () => {
          screenStreamRef.current = null;
          setScreenEnabled(false);

          addEvent(
            "Screen sharing was stopped by the browser.",
            "warning"
          );

          if (interviewActiveRef.current) {
            setError(
              "Screen sharing stopped. Please keep screen sharing enabled during the interview."
            );
          }
        });
      }

      setStatus("Screen sharing ready");
    } catch (err) {
      console.error(err);

      setScreenEnabled(false);

      setError(
        "Screen sharing was not enabled. Please select your entire screen."
      );

      addEvent("Screen sharing permission failed.", "danger");
    }
  }

  // ------------------------------------------------------------
  // Resume upload
  // ------------------------------------------------------------

  async function uploadResume(file) {
    setError("");

    if (!file) return;

    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setError("Please upload a PDF resume.");
      return;
    }

    setLoading(true);

    try {
      const formData = new FormData();

      formData.append("file", file);

      const response = await fetch(`${API}/upload-resume`, {
        method: "POST",
        body: formData,
      });

      const data = await readResponse(response);

      // The backend returns candidate_id for a successful resume upload.
      const id =
        data.candidate_id ||
        data.resume_id ||
        data.id ||
        data.resumeId ||
        null;

      setResumeFile(file);
      setResumeId(id);

      addEvent("Resume uploaded successfully.", "success");

      setStatus("Resume ready");
    } catch (err) {
      console.error("Resume upload error:", err);

      setError(
        `Resume upload failed: ${getErrorMessage(err)}`
      );

      addEvent("Resume upload failed.", "danger");
    } finally {
      setLoading(false);
    }
  }

  // ------------------------------------------------------------
  // Speech synthesis
  // ------------------------------------------------------------

  function speakQuestion(text) {
    if (!text || !("speechSynthesis" in window)) {
      return;
    }

    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);

    utterance.rate = 0.95;
    utterance.pitch = 1;
    utterance.volume = 1;

    utterance.onstart = () => {
      setIsSpeaking(true);
    };

    utterance.onend = () => {
      setIsSpeaking(false);
    };

    utterance.onerror = () => {
      setIsSpeaking(false);
    };

    window.speechSynthesis.speak(utterance);
  }

  // ------------------------------------------------------------
  // Speech recognition
  // ------------------------------------------------------------

  function startListening() {
    setError("");

    const SpeechRecognition =
      window.SpeechRecognition ||
      window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setError(
        "Voice recognition is not supported in this browser. Please use Google Chrome."
      );

      return;
    }

    if (!microphoneEnabled) {
      setError("Please enable your microphone first.");
      return;
    }

    if (!interviewActiveRef.current) {
      setError("Start the interview first.");
      return;
    }

    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {}
    }

    const recognition = new SpeechRecognition();

    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    let finalText = answer;

    recognition.onstart = () => {
      setIsListening(true);
      addEvent("Voice answer started.", "info");
    };

    recognition.onresult = (event) => {
      let interim = "";

      for (
        let i = event.resultIndex;
        i < event.results.length;
        i++
      ) {
        const transcript =
          event.results[i][0].transcript;

        if (event.results[i].isFinal) {
          finalText += transcript + " ";
        } else {
          interim += transcript;
        }
      }

      setAnswer(
        `${finalText}${interim}`.trim()
      );
    };

    recognition.onerror = (event) => {
      console.error(
        "Speech recognition error:",
        event.error
      );

      if (event.error === "not-allowed") {
        setError(
          "Microphone permission was denied."
        );
      } else if (event.error === "network") {
        setError(
          "Browser speech recognition has a network problem. You can type your answer instead."
        );
      }

      setIsListening(false);
    };

    recognition.onend = () => {
      setIsListening(false);
    };

    recognitionRef.current = recognition;

    try {
      recognition.start();
    } catch (err) {
      console.error(err);
    }
  }

  function stopListening() {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {}
    }

    setIsListening(false);
  }

  // ------------------------------------------------------------
  // Recording
  // ------------------------------------------------------------

  function startRecording() {
    if (!cameraStreamRef.current) {
      throw new Error("Camera stream is not available for recording.");
    }

    if (!window.MediaRecorder) {
      throw new Error("This browser does not support interview recording.");
    }

    const stream = cameraStreamRef.current;
    const mimeTypes = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ];

    const mimeType =
      mimeTypes.find((type) => MediaRecorder.isTypeSupported(type)) || "";

    const recorder = mimeType
      ? new MediaRecorder(stream, { mimeType })
      : new MediaRecorder(stream);

    recordingChunksRef.current = [];

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        recordingChunksRef.current.push(event.data);
      }
    };

    recorder.onerror = (event) => {
      console.error("MediaRecorder error:", event);
    };

    recorder.start(1000);
    mediaRecorderRef.current = recorder;

    addEvent("Interview recording started.", "success");
  }

  async function stopRecordingAndUpload(id) {
    const recorder = mediaRecorderRef.current;

    if (!recorder) {
      return null;
    }

    const blob = await new Promise((resolve) => {
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        resolve(
          recordingChunksRef.current.length
            ? new Blob(recordingChunksRef.current, {
                type: recorder.mimeType || "video/webm",
              })
            : null
        );
      };

      recorder.addEventListener("stop", finish, { once: true });

      try {
        if (recorder.state !== "inactive") {
          recorder.stop();
        } else {
          finish();
        }
      } catch (error) {
        console.error("Could not stop recorder:", error);
        finish();
      }
    });

    mediaRecorderRef.current = null;

    if (!blob || blob.size === 0) {
      return null;
    }

    const formData = new FormData();
    formData.append(
      "file",
      new File([blob], `interview_${id}.webm`, {
        type: blob.type || "video/webm",
      })
    );

    const response = await fetch(
      `${API}/upload-recording?interview_id=${Number(id)}`,
      {
        method: "POST",
        body: formData,
      }
    );

    const data = await readResponse(response);
    addEvent("Interview recording saved.", "success");
    return data;
  }

  async function requestInterviewFullscreen() {
    try {
      if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen();
      }
    } catch (error) {
      console.warn("Fullscreen was not granted:", error);
    }
  }

  async function exitInterviewFullscreen() {
    try {
      if (document.fullscreenElement && document.exitFullscreen) {
        await document.exitFullscreen();
      }
    } catch (error) {
      console.warn("Could not exit fullscreen:", error);
    }
  }

  // ------------------------------------------------------------
  // Start interview
  // ------------------------------------------------------------

  async function startInterview() {
    setError("");

    if (!resumeFile) {
      setError("Please upload your resume first.");
      return;
    }

    if (!cameraEnabled || !microphoneEnabled) {
      setError(
        "Please enable camera and microphone before starting."
      );
      return;
    }

    if (!screenEnabled) {
      setError(
        "Please enable screen sharing before starting."
      );
      return;
    }

    setLoading(true);

    try {
      const response = await fetch(
        `${API}/start-interview`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
          candidate_id: Number(resumeId) || 1,
            duration: duration,
            resume_filename: resumeFile.name,
          }),
        }
      );

      const data = await readResponse(response);

      const id =
        data.interview_id ||
        data.id ||
        data.interviewId;

      if (!id) {
        throw new Error(
          "Backend did not return an interview ID."
        );
      }

      setInterviewId(id);
      interviewActiveRef.current = true;
      endingInterviewRef.current = false;

      timerEndRef.current =
        Date.now() + duration * 60 * 1000;

      setTimeLeft(duration * 60);

      setInterviewStarted(true);
      await requestInterviewFullscreen();
      startRecording();

      setScore(null);
      setReport(null);

      addEvent(
        "Live AI interview started.",
        "success"
      );

      setStatus("AI interviewer connected");

      await getNextQuestion(id);
    } catch (err) {
      console.error(
        "START INTERVIEW ERROR:",
        err
      );

      setError(
        `Could not start interview: ${getErrorMessage(err)}`
      );

      interviewActiveRef.current = false;
    } finally {
      setLoading(false);
    }
  }

  // ------------------------------------------------------------
  // Get next AI question
  // ------------------------------------------------------------

  async function getNextQuestion(id = interviewId) {
    if (!id) {
      setError("No active interview exists.");
      return;
    }

    if (!interviewActiveRef.current) {
      return;
    }

    setQuestionLoading(true);

    try {
      const response = await fetch(
        `${API}/next-question`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            interview_id: id,
          }),
        }
      );

      const data = await readResponse(response);

      if (!interviewActiveRef.current) {
        return;
      }

      const nextQuestion =
        data.question ||
        data.next_question ||
        data.text ||
        data.message;

      if (!nextQuestion) {
        throw new Error(
          "Backend did not return an AI question."
        );
      }

      setQuestion(nextQuestion);

      setAnswer("");

      addEvent(
        "AI asked a new question.",
        "info"
      );

      speakQuestion(nextQuestion);
    } catch (err) {
      console.error(
        "NEXT QUESTION ERROR:",
        err
      );

      setError(
        `Could not get AI question: ${getErrorMessage(err)}`
      );
    } finally {
      setQuestionLoading(false);
    }
  }

  // ------------------------------------------------------------
  // Submit answer
  // ------------------------------------------------------------

  async function submitAnswer() {
    if (!interviewActiveRef.current) {
      return;
    }

    if (!answer.trim()) {
      setError("Please give an answer first.");
      return;
    }

    setError("");
    stopListening();

    setLoading(true);

    try {
      const response = await fetch(
        `${API}/answer`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            interview_id: interviewId,
            question,
            answer: answer.trim(),
          }),
        }
      );

      await readResponse(response);

      addEvent(
        "Answer submitted.",
        "success"
      );

      if (interviewActiveRef.current) {
        await getNextQuestion(interviewId);
      }
    } catch (err) {
      console.error(
        "ANSWER ERROR:",
        err
      );

      setError(
        `Could not submit answer: ${getErrorMessage(err)}`
      );
    } finally {
      setLoading(false);
    }
  }

  // ------------------------------------------------------------
  // Stop all media
  // ------------------------------------------------------------

  function stopAllMedia() {
    stopListening();

    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }

    // Stop camera + microphone immediately.
    if (cameraStreamRef.current) {
      cameraStreamRef.current
        .getTracks()
        .forEach((track) => {
          try {
            track.stop();
          } catch {}
        });

      cameraStreamRef.current = null;
    }

    // Stop screen sharing immediately.
    if (screenStreamRef.current) {
      screenStreamRef.current
        .getTracks()
        .forEach((track) => {
          try {
            track.stop();
          } catch {}
        });

      screenStreamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.pause?.();
      videoRef.current.srcObject = null;
    }

    setCameraEnabled(false);
    setMicrophoneEnabled(false);
    setScreenEnabled(false);
  }

  // ------------------------------------------------------------
  // End interview
  // ------------------------------------------------------------

  async function endInterview(autoEnded = false) {
    // Prevent double calls from timer + fullscreen/tab handlers/buttons.
    if (endingInterviewRef.current) {
      return;
    }

    if (!interviewStarted && !interviewActiveRef.current) {
      stopAllMedia();
      timerEndRef.current = null;
      await exitInterviewFullscreen();
      return;
    }

    endingInterviewRef.current = true;
    interviewActiveRef.current = false;

    stopListening();

    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }

    setStatus(
      autoEnded
        ? "Interview time completed"
        : "Ending interview..."
    );

    // Hide the live interview immediately.
    setInterviewStarted(false);
    timerEndRef.current = null;

    const id = Number(interviewId);

    // Stop the MediaRecorder and prepare its upload promise.
    // We stop all camera/mic/screen tracks immediately below.
    let recordingPromise = Promise.resolve(null);

    if (id && mediaRecorderRef.current) {
      recordingPromise =
        stopRecordingAndUpload(id).catch(
          (recordingError) => {
            console.error(
              "RECORDING UPLOAD ERROR:",
              recordingError
            );

            addEvent(
              "Recording could not be uploaded.",
              "danger"
            );

            return null;
          }
        );
    }

    // IMPORTANT: turn OFF camera, microphone and screen NOW.
    // Do not wait for recording upload or report generation.
    stopAllMedia();

    try {
      if (id) {
        await recordingPromise;

        const response = await fetch(
          `${API}/end-interview`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              interview_id: id,
            }),
          }
        );

        await readResponse(response);

        const reportResponse = await fetch(
          `${API}/report/${id}`
        );

        const reportData =
          await readResponse(reportResponse);

        setReport(reportData);
        setScore(
          Number(reportData.average_score ?? 0)
        );

        addEvent(
          "Interview result saved.",
          "success"
        );
      }
    } catch (err) {
      console.error(
        "END INTERVIEW ERROR:",
        err
      );

      setError(
        `Interview ended, but report could not be loaded: ${getErrorMessage(err)}`
      );
    } finally {
      stopAllMedia();
      await exitInterviewFullscreen();

      setQuestion("");
      setAnswer("");
      setTimeLeft(0);
      setStatus("Interview ended");

      endingInterviewRef.current = false;
    }
  }

  // ------------------------------------------------------------
  // Interview countdown timer
  // ------------------------------------------------------------

  endInterviewRef.current = endInterview;

  useEffect(() => {
    if (!interviewStarted) {
      return;
    }

    if (!timerEndRef.current) {
      timerEndRef.current =
        Date.now() + timeLeft * 1000;
    }

    let intervalId = null;

    const updateTimer = () => {
      if (!timerEndRef.current) {
        return;
      }

      const remaining = Math.max(
        0,
        Math.ceil(
          (timerEndRef.current - Date.now()) / 1000
        )
      );

      setTimeLeft(remaining);

      if (remaining <= 0) {
        if (intervalId !== null) {
          window.clearInterval(intervalId);
        }

        if (
          endInterviewRef.current &&
          !endingInterviewRef.current
        ) {
          endInterviewRef.current(true);
        }
      }
    };

    updateTimer();
    intervalId = window.setInterval(
      updateTimer,
      1000
    );

    return () => {
      if (intervalId !== null) {
        window.clearInterval(intervalId);
      }
    };
  }, [interviewStarted]);

  // ------------------------------------------------------------
  // Anti-cheating monitoring
  // ------------------------------------------------------------

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!interviewActiveRef.current) return;

      if (document.hidden) {
        addEvent(
          "Candidate changed browser tab or window.",
          "danger"
        );

        fetch(`${API}/monitoring-event`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            interview_id: Number(interviewId),
            event_type: "tab_hidden",
            message: "Candidate changed browser tab or window during the interview.",
          }),
        }).catch(console.error);

        endInterview(false);
      }
    };

    const handleFullscreenChange = () => {
      if (!interviewActiveRef.current) return;

      if (!document.fullscreenElement) {
        addEvent(
          "Candidate exited fullscreen mode.",
          "danger"
        );

        fetch(`${API}/monitoring-event`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            interview_id: Number(interviewId),
            event_type: "fullscreen_exit",
            message: "Candidate exited fullscreen mode during the interview.",
          }),
        }).catch(console.error);

        endInterview(false);
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    document.addEventListener("fullscreenchange", handleFullscreenChange);

    return () => {
      document.removeEventListener(
        "visibilitychange",
        handleVisibilityChange
      );
      document.removeEventListener(
        "fullscreenchange",
        handleFullscreenChange
      );
    };
  }, [interviewId]);

  // ------------------------------------------------------------
  // Timer
  // ------------------------------------------------------------

 // ------------------------------------------------------------
// ATTACH CAMERA STREAM TO VIDEO AFTER INTERVIEW PAGE RENDERS
// ------------------------------------------------------------
useEffect(() => {
  if (!interviewStarted) return;

  const video = videoRef.current;
  const stream = cameraStreamRef.current;

  if (!video || !stream) {
    console.warn("Camera video element or stream is missing.");
    return;
  }

  // Attach the already-running camera stream
  video.srcObject = stream;
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;

  const startVideo = async () => {
    try {
      await video.play();
    } catch (error) {
      console.error("Camera video play failed:", error);
    }
  };

  // Wait until the video has metadata
  if (video.readyState >= 1) {
    startVideo();
  } else {
    video.onloadedmetadata = startVideo;
  }

  return () => {
    video.onloadedmetadata = null;
  };
}, [interviewStarted]);

  // ------------------------------------------------------------
  // Cleanup when page closes
  // ------------------------------------------------------------

  useEffect(() => {
    const cleanup = () => {
      endingInterviewRef.current = true;
      interviewActiveRef.current = false;
      timerEndRef.current = null;

      if (mediaRecorderRef.current) {
        try {
          if (
            mediaRecorderRef.current.state !==
            "inactive"
          ) {
            mediaRecorderRef.current.stop();
          }
        } catch {}
        mediaRecorderRef.current = null;
      }

      stopAllMedia();
    };

    window.addEventListener(
      "beforeunload",
      cleanup
    );

    return () => {
      window.removeEventListener(
        "beforeunload",
        cleanup
      );

      stopAllMedia();
    };
  }, []);

  // ------------------------------------------------------------
  // Timer display
  // ------------------------------------------------------------

  function formatTime(seconds) {
    const minutes = Math.floor(
      seconds / 60
    );

    const remainingSeconds =
      seconds % 60;

    return `${String(minutes).padStart(
      2,
      "0"
    )}:${String(
      remainingSeconds
    ).padStart(2, "0")}`;
  }

  // ------------------------------------------------------------
  // New interview
  // ------------------------------------------------------------

  function resetInterview() {
    stopAllMedia();

    interviewActiveRef.current = false;

    setInterviewStarted(false);
    setInterviewId(null);

    setQuestion("");
    setAnswer("");

    setScore(null);
    setReport(null);

    setEvents([]);

    setStatus("Ready");
    setError("");

    timerEndRef.current = null;
    endingInterviewRef.current = false;

    setTimeLeft(duration * 60);
  }

  const canStart =
    resumeFile &&
    cameraEnabled &&
    microphoneEnabled &&
    screenEnabled &&
    !interviewStarted;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-icon">
            AI
          </div>

          <div>
            <h1>AI Interview Pro</h1>
            <p>
              Resume-based live interview platform
            </p>
          </div>
        </div>

        <div className="top-status">
          <span
            className={
              interviewStarted
                ? "status-dot live"
                : "status-dot"
            }
          />

          {interviewStarted
            ? "Interview Live"
            : status}
        </div>
      </header>

      <main className="main-container">
        {!interviewStarted && (
          <>
            <section className="hero">
              <div className="hero-badge">
                ✦ AI POWERED INTERVIEW
              </div>

              <h2>
                Practice interviews like a
                real company interview
              </h2>

              <p>
                Upload your resume, choose your
                interview duration, enable your
                camera, microphone and screen,
                then let the AI interviewer guide
                the session.
              </p>
            </section>

            <section className="setup-grid">
              {/* Resume */}
              <div className="card">
                <div className="step-number">
                  01
                </div>

                <h3>Upload Resume</h3>

                <p className="muted">
                  Questions will be generated
                  according to your resume.
                </p>

                <label className="upload-box">
                  <span className="upload-icon">
                    ↑
                  </span>

                  <strong>
                    {resumeFile
                      ? resumeFile.name
                      : "Choose your resume"}
                  </strong>

                  <small>
                    PDF format recommended
                  </small>

                  <input
                    type="file"
                    accept=".pdf"
                    onChange={(event) => {
                      const file =
                        event.target.files?.[0];

                      if (file) {
                        uploadResume(file);
                      }
                    }}
                  />
                </label>

                {resumeFile && (
                  <div className="success-message">
                    ✓ Resume uploaded successfully
                  </div>
                )}
              </div>

              {/* Duration */}
              <div className="card">
                <div className="step-number">
                  02
                </div>

                <h3>
                  Choose Interview Duration
                </h3>

                <p className="muted">
                  The AI will continue asking
                  questions until the selected
                  time ends.
                </p>

                <div className="duration-grid">
                  {DURATIONS.map((item) => (
                    <button
                      key={item.value}
                      className={
                        duration === item.value
                          ? "duration-card selected"
                          : "duration-card"
                      }
                      onClick={() =>
                        setDuration(
                          item.value
                        )
                      }
                      disabled={interviewStarted}
                    >
                      <strong>
                        {item.label}
                      </strong>

                      <span>
                        {item.description}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Permissions */}
              <div className="card">
                <div className="step-number">
                  03
                </div>

                <h3>
                  Enable Interview Monitoring
                </h3>

                <p className="muted">
                  Camera, microphone and entire
                  screen are required.
                </p>

                <div className="permission-list">
                  <div
                    className={
                      cameraEnabled
                        ? "permission active"
                        : "permission"
                    }
                  >
                    <span>🎥</span>

                    <div>
                      <strong>
                        Camera
                      </strong>

                      <small>
                        {cameraEnabled
                          ? "Enabled"
                          : "Not enabled"}
                      </small>
                    </div>

                    {!cameraEnabled && (
                      <button
                        className="small-button"
                        onClick={
                          enableCameraAndMicrophone
                        }
                      >
                        Enable
                      </button>
                    )}
                  </div>

                  <div
                    className={
                      microphoneEnabled
                        ? "permission active"
                        : "permission"
                    }
                  >
                    <span>🎙️</span>

                    <div>
                      <strong>
                        Microphone
                      </strong>

                      <small>
                        {microphoneEnabled
                          ? "Enabled"
                          : "Not enabled"}
                      </small>
                    </div>
                  </div>

                  <div
                    className={
                      screenEnabled
                        ? "permission active"
                        : "permission"
                    }
                  >
                    <span>🖥️</span>

                    <div>
                      <strong>
                        Screen Sharing
                      </strong>

                      <small>
                        {screenEnabled
                          ? "Entire screen enabled"
                          : "Not enabled"}
                      </small>
                    </div>

                    {!screenEnabled && (
                      <button
                        className="small-button"
                        onClick={
                          enableScreenSharing
                        }
                      >
                        Enable
                      </button>
                    )}
                  </div>
                </div>

                {!cameraEnabled && (
                  <button
                    className="secondary-button full"
                    onClick={
                      enableCameraAndMicrophone
                    }
                  >
                    🎥 Enable Camera + Microphone
                  </button>
                )}

                {!screenEnabled && (
                  <button
                    className="secondary-button full"
                    onClick={
                      enableScreenSharing
                    }
                  >
                    🖥️ Enable Entire Screen
                  </button>
                )}
              </div>
            </section>

            <section className="start-section">
              <button
                className="start-button"
                disabled={!canStart || loading}
                onClick={startInterview}
              >
                {loading
                  ? "Starting Interview..."
                  : "Start Live AI Interview →"}
              </button>

              <p>
                Camera, microphone and screen
                sharing will automatically stop
                when the interview ends.
              </p>
            </section>
          </>
        )}

        {interviewStarted && (
          <section className="interview-page">
            <div className="interview-header">
              <div>
                <div className="live-label">
                  <span className="live-dot" />
                  LIVE INTERVIEW
                </div>

                <h2>
                  AI Interviewer
                </h2>
              </div>

              <div className="timer">
                <span>
                  Time Remaining
                </span>

                <strong>
                  {formatTime(timeLeft)}
                </strong>
              </div>
            </div>

            <div className="interview-grid">
              {/* Left */}
              <div className="left-column">
                <div className="video-card">
                  <div className="video-header">
                    <span>
                      Candidate Camera
                    </span>

                    <span className="camera-live">
                      ● LIVE
                    </span>
                  </div>

                  <div className="video-container">
                    <video
                      ref={videoRef}
                      autoPlay
                      muted
                      playsInline
                    />

                    {!cameraEnabled && (
                      <div className="video-placeholder">
                        <span>🎥</span>
                        Camera unavailable
                      </div>
                    )}
                  </div>
                </div>

                <div className="monitor-card">
                  <h3>
                    Interview Monitoring
                  </h3>

                  <div className="monitor-row">
                    <span>Camera</span>

                    <strong
                      className={
                        cameraEnabled
                          ? "green"
                          : "red"
                      }
                    >
                      ●{" "}
                      {cameraEnabled
                        ? "Active"
                        : "Off"}
                    </strong>
                  </div>

                  <div className="monitor-row">
                    <span>Microphone</span>

                    <strong
                      className={
                        microphoneEnabled
                          ? "green"
                          : "red"
                      }
                    >
                      ●{" "}
                      {microphoneEnabled
                        ? "Active"
                        : "Off"}
                    </strong>
                  </div>

                  <div className="monitor-row">
                    <span>Screen</span>

                    <strong
                      className={
                        screenEnabled
                          ? "green"
                          : "red"
                      }
                    >
                      ●{" "}
                      {screenEnabled
                        ? "Active"
                        : "Off"}
                    </strong>
                  </div>

                  <div className="monitor-row">
                    <span>
                      Monitoring events
                    </span>

                    <strong>
                      {events.length}
                    </strong>
                  </div>
                </div>

                <button
                  className="end-button"
                  onClick={() =>
                    endInterview(false)
                  }
                >
                  End Interview
                </button>
              </div>

              {/* Right */}
              <div className="right-column">
                <div className="ai-card">
                  <div className="ai-heading">
                    <div className="ai-avatar">
                      🤖
                    </div>

                    <div>
                      <h3>
                        AI Interviewer
                      </h3>

                      <span>
                        {isSpeaking
                          ? "Speaking..."
                          : "Connected"}
                      </span>
                    </div>
                  </div>

                  <div className="question-box">
                    <div className="box-label">
                      AI QUESTION
                    </div>

                    {questionLoading ? (
                      <div className="loading-question">
                        <span />
                        <span />
                        <span />
                      </div>
                    ) : (
                      <p>
                        {question ||
                          "Waiting for AI question..."}
                      </p>
                    )}
                  </div>

                  <div className="answer-section">
                    <div className="box-label">
                      YOUR ANSWER
                    </div>

                    <textarea
                      className="written-answer-box"
                      value={answer}
                      onChange={(event) =>
                        setAnswer(
                          event.target.value
                        )
                      }
                      placeholder="Speak your answer or type it here..."
                    />

                    <div className="answer-controls">
                      <button
                        className={
                          isListening
                            ? "voice-button listening"
                            : "voice-button"
                        }
                        onClick={
                          isListening
                            ? stopListening
                            : startListening
                        }
                      >
                        {isListening
                          ? "■ Stop Speaking"
                          : "🎙 Start Speaking"}
                      </button>

                      <button
                        className="submit-button"
                        disabled={
                          loading ||
                          !answer.trim()
                        }
                        onClick={
                          submitAnswer
                        }
                      >
                        {loading
                          ? "Submitting..."
                          : "Submit Answer →"}
                      </button>
                    </div>
                  </div>
                </div>

                <div className="events-card">
                  <h3>
                    Monitoring Events
                  </h3>

                  {events.length === 0 ? (
                    <p className="muted">
                      No events yet.
                    </p>
                  ) : (
                    <div className="event-list">
                      {events.map(
                        (event) => (
                          <div
                            className={`event ${event.type}`}
                            key={event.id}
                          >
                            <span>
                              {event.time}
                            </span>

                            <strong>
                              {event.message}
                            </strong>
                          </div>
                        )
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </section>
        )}

        {/* Error */}
        {error && (
          <div className="error-banner">
            <span>⚠️</span>

            <div>
              <strong>
                Something went wrong
              </strong>

              <p>{error}</p>
            </div>

            <button
              onClick={() => setError("")}
            >
              ×
            </button>
          </div>
        )}

        {/* Report */}
        {!interviewStarted &&
          (score !== null || report) && (
            <section className="report-card">
              <div className="report-icon">
                ✓
              </div>

              <h2>
                Interview Completed
              </h2>

              <p>
                Your interview has been saved.
              </p>

              {score !== null && (
                <div className="score-box">
                  <span>
                    Final Score
                  </span>

                  <strong>
                    {score}
                    <small>/10</small>
                  </strong>
                </div>
              )}

              {report && (
                <div className="report-text">
                  <h3>AI Interview Report</h3>

                  <div className="report-summary-grid">
                    <div className="report-summary-item">
                      <span>Candidate</span>
                      <strong>
                        {report?.candidate?.name || "Candidate"}
                      </strong>
                    </div>

                    <div className="report-summary-item">
                      <span>Duration</span>
                      <strong>
                        {report?.duration ?? 0} minutes
                      </strong>
                    </div>

                    <div className="report-summary-item">
                      <span>Grade</span>
                      <strong>
                        {report?.grade || "N/A"}
                      </strong>
                    </div>

                    <div className="report-summary-item">
                      <span>Monitoring</span>
                      <strong>
                        {report?.monitoring_score ?? 100}%
                      </strong>
                    </div>
                  </div>

                  <div className="report-feedback-block">
                    <h4>AI Feedback</h4>
                    <p>
                      {report?.overall_feedback ||
                        "Interview report generated successfully."}
                    </p>
                  </div>

                  <div className="report-two-columns">
                    <div className="report-feedback-block">
                      <h4>Strengths</h4>
                      <ul>
                        {(report?.strengths || []).slice(0, 5).map(
                          (item, index) => (
                            <li key={`strength-${index}`}>
                              {item}
                            </li>
                          )
                        )}
                        {!(report?.strengths || []).length && (
                          <li>No specific strengths recorded.</li>
                        )}
                      </ul>
                    </div>

                    <div className="report-feedback-block">
                      <h4>Areas to Improve</h4>
                      <ul>
                        {(report?.improvements || []).slice(0, 5).map(
                          (item, index) => (
                            <li key={`improvement-${index}`}>
                              {item}
                            </li>
                          )
                        )}
                        {!(report?.improvements || []).length && (
                          <li>Keep practicing clear and specific answers.</li>
                        )}
                      </ul>
                    </div>
                  </div>

                  <div className="report-status-row">
                    <span>Answers Evaluated</span>
                    <strong>
                      {report?.answered_questions ?? 0}
                    </strong>
                  </div>

                  <div className="report-status-row">
                    <span>Status</span>
                    <strong>
                      {report?.status || "completed"}
                    </strong>
                  </div>

                  {/* Questions, answers, monitoring events and recording URL
                      are intentionally not shown to the candidate here. */}
                </div>
              )}

              <button
                className="start-button report-button"
                onClick={resetInterview}
              >
                Start New Interview
              </button>
            </section>
          )}
      </main>

      <footer>
        <p>
          AI Interview Pro • Resume-based
          interview practice
        </p>
      </footer>
    </div>
  );
}

export default App;
